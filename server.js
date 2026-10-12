require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const cron = require('node-cron'); // NEW: For automated scheduling

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

async function retryingFetch(url, opts) {
  let res;
  for (let i = 0; i < 4; i++) {
    try {
      res = await fetch(url, opts);
      if (![502, 503, 504].includes(res.status)) return res;
    } catch (e) {
      if (i === 3) throw e;
    }
    await new Promise(r => setTimeout(r, 1000 * (i + 1)));
  }
  return res;
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { global: { fetch: retryingFetch } });
const transporter = nodemailer.createTransport({
  service: 'gmail', 
  auth: { user: process.env.SMTP_EMAIL, pass: process.env.SMTP_PASSWORD }
});

// --- COMBINED EMAIL FUNCTION ---
async function sendCombinedAlertEmail(resultsArray) {
  if (process.env.EMAIL_ENABLED !== '1') { console.log('ℹ️ Email alerts are disabled (Google Chat only).'); return; }
  let emailHtml = `<h2>🚨 Competitor Radar Update</h2><p>A system scan has completed. Here are the latest changes across your monitored competitors.</p>`;
  let hasActualChanges = false;

  resultsArray.forEach(res => {
    if (res.data.status === 'PAUSED') return;

    const compName = res.competitor;
    const newC = res.data.newCourses || [];
    const modC = res.data.modifiedCourses || [];

    if (newC.length > 0 || modC.length > 0) {
      hasActualChanges = true;
      emailHtml += `<hr style="margin: 20px 0; border: 1px solid #eee;"><h3>🏢 ${compName}</h3>`;

      if (newC.length > 0) {
        emailHtml += `<h4 style="color: #16a34a;">🌟 New Content Added (${newC.length}):</h4><ul>`;
        newC.forEach(c => emailHtml += `<li><span style="font-size:12px; color:gray;">[${c.category}]</span> <strong>${c.title}</strong> - <a href="${c.course_url}">View Link</a></li>`);
        emailHtml += `</ul>`;
      }

      if (modC.length > 0) {
        emailHtml += `<h4 style="color: #ca8a04;">📝 Content Modified / Outline Changed (${modC.length}):</h4><ul>`;
        modC.forEach(c => emailHtml += `<li><span style="font-size:12px; color:gray;">[${c.category}]</span> <strong>${c.title}</strong> - <a href="${c.course_url}">View Link</a>${c.change_note ? `<div style="font-size:12px;color:#92400e">${c.change_note}</div>` : ''}</li>`);
        emailHtml += `</ul>`;
      }
    }
  });

  if (!hasActualChanges) {
    console.log('ℹ️ No changes detected across any competitors. Skipping combined email.');
    return;
  }

  console.log(`📧 Sending COMBINED email alert via SMTP...`);
  try {
    await transporter.sendMail({
      from: `"Competitor Radar" <${process.env.SMTP_EMAIL}>`, 
      to: process.env.ALERT_EMAIL_TO,
      subject: `[ALERT] Updates Detected on Competitor Websites`,
      html: emailHtml
    });
    console.log('✅ Combined SMTP Email sent successfully.');
  } catch (error) {
    console.error('❌ Failed to send combined SMTP email:', error);
  }
}

// --- BROWSER CONFIG ---
const BROWSER_CONFIG = { headless: true }; 
const VIEWPORT_CONFIG = {
  viewport: { width: 1920, height: 1080 },
  // Playwright's default headless UA string gets flagged by some sites' WAF/bot
  // protection (e.g. Skillsoft returns a CloudFront block page otherwise).
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
};

// ==========================================
// 1. PLURALSIGHT SCRAPER
// ==========================================

const CONTENT_TYPES = ['Course','Training','E-Learning','Certification','Workshop','Blog','Webinar','Event','Case Study','Research','Guide','Resource'];
function classifyType(x) {
  const cat = String(x.category || '').trim();
  if (CONTENT_TYPES.includes(cat)) return cat;
  const url = String(x.course_url || '').toLowerCase();
  let path = url;
  try { path = new URL(x.course_url).pathname.toLowerCase(); } catch (_) {}
  const c = cat.toLowerCase();
  const t = String(x.title || '').toLowerCase();
  if (/webinar/.test(c) || /webinar/.test(path)) return 'Webinar';
  if (/\bevent/.test(c) || /\/events?(\/|$)/.test(path)) return 'Event';
  if (/case[- ]stud/.test(c) || /case-stud/.test(path)) return 'Case Study';
  if (/\bblog/.test(c) || /(^|[\/.])blogs?([\/.?]|$)/.test(url)) return 'Blog';
  if (/research/.test(c) || /\/research(\/|$)/.test(path)) return 'Research';
  if (/guide|tutorial|ebook|whitepaper/.test(path)) return 'Guide';
  if (/resource/.test(c) || /\/resources?(\/|$)/.test(path)) return 'Resource';
  if (/e-?learning/.test(t)) return 'E-Learning';
  if (/boot ?camp|workshop/.test(t)) return 'Workshop';
  if (/certif|exam prep/.test(t)) return 'Certification';
  if (/\/training/.test(path) && !/course/.test(path)) return 'Training';
  return 'Course';
}
function withType(x) { x.category = classifyType(x); return x; }

async function scrapePluralsight() {
    console.log('🚀 Starting Pluralsight Scraper...');
    let browser, syncStatus = 'FAILED', totalCoursesFound = 0;
    let detectedChanges = { newCourses: [], modifiedCourses: [] };

    const { data: comp } = await supabase.from('competitors').select('*').eq('name', 'Pluralsight').single();
    if (!comp) return { status: 'FAILED', error: 'Not found in DB' };

    try {
        browser = await chromium.launch(BROWSER_CONFIG);
        const context = await browser.newContext(VIEWPORT_CONFIG);
        const page = await context.newPage();
        const allExtractedContent = new Map();
        const normalizeUrl = (href) => href.startsWith('http') ? href : `https://www.pluralsight.com${href}`;

        // ==========================================================
        // PLURALSIGHT CONTENT DISCOVERY
        // Courses + Learning Paths + Labs
        // ==========================================================

        const contentSources = [
            { url: 'https://www.pluralsight.com/courses', category: 'Course' },
            { url: 'https://www.pluralsight.com/paths', category: 'Learning Path' },
            { url: 'https://www.pluralsight.com/labs', category: 'Lab' }
        ];

        for (const source of contentSources) {
            try {
                console.log(`   🔎 Pluralsight: scanning ${source.category} source ${source.url}`);

                await page.goto(source.url, {
                    waitUntil: 'domcontentloaded',
                    timeout: 45000
                });

                await page.waitForTimeout(3000);

                // Scroll so dynamically rendered cards have a chance to appear.
                await page.evaluate(async () => {
                    for (let i = 0; i < 8; i++) {
                        window.scrollBy(0, 900);
                        await new Promise(resolve => setTimeout(resolve, 700));
                    }
                });

                await page.waitForTimeout(2000);

                const extracted = await page.evaluate((sourceCategory) => {
                    const items = [];
                    const seen = new Set();

                    document.querySelectorAll('a[href]').forEach(link => {
                        const href = link.getAttribute('href') || '';

                        if (!href || href.startsWith('#') || href.startsWith('javascript:')) {
                            return;
                        }

                        let absoluteUrl;

                        try {
                            absoluteUrl = new URL(href, window.location.origin).href;
                        } catch (_) {
                            return;
                        }

                        const parsed = new URL(absoluteUrl);
                        const path = parsed.pathname.toLowerCase();

                        let category = null;

                        if (/^\/courses\/[^/]+/i.test(path)) {
                            category = 'Course';
                        } else if (/^\/paths\/[^/]+/i.test(path)) {
                            category = 'Learning Path';
                        } else if (/^\/labs\/[^/]+/i.test(path)) {
                            category = 'Lab';
                        }

                        // Keep source category as fallback only when
                        // the source itself is a valid content area.
                        if (!category) {
                            if (sourceCategory === 'Course' && /^\/courses\/[^/]+/i.test(path)) {
                                category = 'Course';
                            } else if (sourceCategory === 'Learning Path' && /^\/paths\/[^/]+/i.test(path)) {
                                category = 'Learning Path';
                            } else if (sourceCategory === 'Lab' && /^\/labs\/[^/]+/i.test(path)) {
                                category = 'Lab';
                            }
                        }

                        if (!category) return;

                        const title =
                            link.querySelector('h1,h2,h3,h4,h5,[class*="title"]')?.innerText?.trim() ||
                            link.getAttribute('aria-label')?.trim() ||
                            link.innerText?.replace(/\s+/g, ' ')?.trim();

                        if (!title || title.length < 3) return;

                        const cleanUrl = absoluteUrl.split('#')[0].replace(/\/$/, '');

                        if (seen.has(cleanUrl)) return;
                        seen.add(cleanUrl);

                        items.push({
                            title,
                            url: cleanUrl,
                            category
                        });
                    });

                    return items;
                }, source.category);

                console.log(
                    `      📚 ${source.category}: extracted ${extracted.length}`
                );

                extracted.forEach(item => {
                    const url = normalizeUrl(item.url);

                    if (!url) return;

                    allExtractedContent.set(url, {
                        title: item.title,
                        course_url: url,
                        category: item.category,
                        description: `Pluralsight ${item.category}`
                    });
                });

            } catch (err) {
                console.log(
                    `      ⚠️ ${source.category} source skipped: ${err.message}`
                );
            }
        }

        console.log(
            `   📦 Pluralsight content collected so far: ${allExtractedContent.size}`
        );

        const blogConfigs = [
            { tag: 'software-development', pages: 6 },
            { tag: 'cloud', pages: 2 },
            { tag: 'tech-operations', pages: 2 },
            { tag: 'ai-and-data', pages: 2 },
            { tag: 'cybersecurity', pages: 2 }
        ];

        for (const config of blogConfigs) {
            for (let p = 1; p <= config.pages; p++) {
                const url = `https://www.pluralsight.com/resources/blog?page=${p}&unified-tags=${config.tag}`;
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
                await page.waitForTimeout(2000); 
                
                const blogs = await page.evaluate((categoryName) => {
                    const items = [];
                    document.querySelectorAll('.cmp-title__text').forEach(el => {
                        const title = el.innerText.trim();
                        if (title.length < 3) return;
                        const card = el.closest('.resource-card') || el.closest('a')?.parentElement;
                        const link = card ? card.querySelector('a[href]') : el.closest('a');
                        if (link) items.push({ title, url: link.getAttribute('href'), category: `Blog (${categoryName})` });
                    });
                    return items;
                }, config.tag);
                
                blogs.forEach(item => {
                    if (item.url && !item.url.includes('javascript:')) {
                        allExtractedContent.set(normalizeUrl(item.url), { title: item.title, course_url: normalizeUrl(item.url), category: item.category, description: `Pluralsight ${item.category}` });
                    }
                });
            }
        }

        for (let p = 1; p <= 2; p++) {
            const url = `https://www.pluralsight.com/resources/events?page=${p}`;
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await page.waitForTimeout(2000);
            
            const events = await page.evaluate(() => {
                const items = [];
                document.querySelectorAll('.cmp-title__text').forEach(el => {
                    const title = el.innerText.trim();
                    if (title.length < 3) return;
                    const card = el.closest('.resource-card') || el.closest('a')?.parentElement;
                    const link = card ? card.querySelector('a[href]') : el.closest('a');
                    if (link) items.push({ title, url: link.getAttribute('href'), category: `Event` });
                });
                return items;
            });
            
            events.forEach(item => {
                if(item.url && !item.url.includes('javascript:')) {
                    allExtractedContent.set(normalizeUrl(item.url), { title: item.title, course_url: normalizeUrl(item.url), category: item.category, description: `Pluralsight ${item.category}` });
                }
            });
        }

        await page.goto('https://www.pluralsight.com/resources/webinars', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(2000);

        let hasMore = true, loadCount = 0;
        while (hasMore && loadCount < 4) {
            try {
                const loadBtn = page.locator('.contentlist__action-button').last();
                if (await loadBtn.isVisible()) {
                    await loadBtn.click();
                    await page.waitForTimeout(2000);
                    loadCount++;
                } else { hasMore = false; }
            } catch (e) { hasMore = false; }
        }

        const webinars = await page.evaluate(() => {
            const items = [];
            const heroTitle = document.querySelector('.hero-title');
            const heroLink = document.querySelector('.webinarreferencehero-button');
            if (heroTitle && heroLink) items.push({ title: heroTitle.innerText.trim(), url: heroLink.getAttribute('href'), category: 'Live Webinar' });
            
            document.querySelectorAll('.contentlist-resource-card, .resource-card').forEach(card => {
                const titleNode = card.querySelector('.contentlist-card-title, .cmp-title__text');
                const linkNode = card.querySelector('a[href]');
                if (titleNode && linkNode) items.push({ title: titleNode.innerText.trim(), url: linkNode.getAttribute('href'), category: 'On-Demand Webinar' });
            });
            return items;
        });

        webinars.forEach(item => {
            if(item.url && !item.url.includes('javascript:')) allExtractedContent.set(normalizeUrl(item.url), { title: item.title, course_url: normalizeUrl(item.url), category: item.category, description: `Pluralsight ${item.category}` });
        });

        // EARLY CLOSE BROWSER TO SAVE MEMORY
        if (browser) { await browser.close(); browser = null; }

        totalCoursesFound = allExtractedContent.size;
        console.log(`✅ Pluralsight Scrape Complete. Found: ${totalCoursesFound}`);
        console.log(`   ⏳ Syncing to Supabase Database...`);
        
        let dbCount = 0;
        for (const [url, item] of allExtractedContent.entries()) {
            dbCount++;
            if (dbCount % 100 === 0) console.log(`      💾 Synced ${dbCount}/${totalCoursesFound} to database...`);
            const { data: existing } = await supabase.from('courses').select('id, description').eq('competitor_id', comp.id).eq('course_url', item.course_url).single();
            if (!existing) {
                await supabase.from('courses').insert({ ...withType(item), competitor_id: comp.id });
                detectedChanges.newCourses.push(item);
            } else {
                await supabase.from('courses').update({ last_seen_at: new Date().toISOString() }).eq('id', existing.id);
            }
        }
        syncStatus = 'SUCCESS';
    } catch (e) {
        console.error('❌ Pluralsight Scraping failed:', e);
    } finally {
        if (browser) await browser.close();
        await supabase.from('sync_logs').insert({ competitor_id: comp.id, status: syncStatus, courses_found: totalCoursesFound, new_courses_added: detectedChanges.newCourses.length });
        return { status: syncStatus, totalCoursesFound, newCourses: detectedChanges.newCourses, modifiedCourses: detectedChanges.modifiedCourses };
    }
}

// ==========================================
// 2. LEARNING TREE SCRAPER
// ==========================================
async function scrapeLearningTree() {
  console.log('🚀 Starting Learning Tree Scraper...');
  let browser, syncStatus = 'FAILED', totalCoursesFound = 0;
  let detectedChanges = { newCourses: [], modifiedCourses: [] };

  const { data: comp } = await supabase.from('competitors').select('*').eq('name', 'Learning Tree').single();
  if (!comp) return { status: 'FAILED', error: 'Not found in DB' };

  try {
    browser = await chromium.launch(BROWSER_CONFIG);
    const context = await browser.newContext(VIEWPORT_CONFIG);
    const page = await context.newPage();
    const targetUrl = comp.base_url.includes('/courses') ? comp.base_url : `${comp.base_url}/courses/`;
    
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    const courses = await page.evaluate(() => {
        const nodes = document.querySelectorAll('a[href*="/course"], a[href*="/training"]');
        let extracted = [];
        nodes.forEach(n => {
            const title = n.innerText.trim();
            if(title.length > 5) extracted.push({ title: title, course_url: n.href, category: 'IT Training', description: 'Course entry' });
        });
        return extracted;
    });

    if (browser) { await browser.close(); browser = null; }

    totalCoursesFound = courses.length;
    console.log(`✅ Learning Tree Scrape Complete. Found: ${totalCoursesFound}`);
    console.log(`   ⏳ Syncing to Supabase Database...`);

    let dbCount = 0;
    for (const course of courses) {
        dbCount++;
        if (dbCount % 100 === 0) console.log(`      💾 Synced ${dbCount}/${totalCoursesFound} to database...`);
        const { data: existing } = await supabase.from('courses').select('id, description').eq('competitor_id', comp.id).eq('course_url', course.course_url).single();
        if (!existing) {
          await supabase.from('courses').insert({ ...withType(course), competitor_id: comp.id });
          detectedChanges.newCourses.push(course);
        } else {
          await supabase.from('courses').update({ last_seen_at: new Date().toISOString() }).eq('id', existing.id);
        }
    }
    syncStatus = 'SUCCESS';
  } catch (error) {
    console.error('❌ Learning Tree Scraping failed:', error);
  } finally {
    if (browser) await browser.close();
    await supabase.from('sync_logs').insert({ competitor_id: comp.id, status: syncStatus, courses_found: totalCoursesFound, new_courses_added: detectedChanges.newCourses.length });
    return { status: syncStatus, totalCoursesFound, newCourses: detectedChanges.newCourses, modifiedCourses: detectedChanges.modifiedCourses };
  }
}

// ==========================================
// 3. DATACOUCH SCRAPER
// ==========================================
async function scrapeDatacouch() {
  console.log('🚀 Starting Datacouch Scraper (Deep Scrape)...');
  let browser, syncStatus = 'FAILED', totalCoursesFound = 0;
  let detectedChanges = { newCourses: [], modifiedCourses: [] };

  const { data: comp } = await supabase.from('competitors').select('*').eq('name', 'Datacouch').single();
  if (!comp) return { status: 'FAILED', error: 'Not found in DB' };

  try {
    browser = await chromium.launch(BROWSER_CONFIG);
    const context = await browser.newContext(VIEWPORT_CONFIG);
    const page = await context.newPage();

    console.log(`📄 Datacouch: Navigating to main page to extract categories...`);
    await page.goto(comp.base_url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    let categoryUrls = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a'))
            .map(a => a.href)
            .filter(href => href.includes('/course/') && !href.toLowerCase().includes('our-courses'))
            .filter((value, index, self) => self.indexOf(value) === index); 
    });

    console.log(`   🔍 Found ${categoryUrls.length} Category Pages to scan sequentially.`);
    const allExtractedCourses = new Map(); 

    for (const catUrl of categoryUrls) {
      try {
        console.log(`   👉 Visiting Category URL: ${catUrl}`);
        await page.goto(catUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2000);

        let hasMore = true, loadCount = 0;
        while (hasMore && loadCount < 10) {
          try {
            const loadMoreBtn = page.locator('button:has-text("Load More"), a:has-text("Load More")').last();
            if (await loadMoreBtn.isVisible()) {
              await loadMoreBtn.click();
              await page.waitForTimeout(2000); 
              loadCount++;
            } else { hasMore = false; }
          } catch (e) { hasMore = false; }
        }

        const courses = await page.evaluate((urlStr) => {
          const extracted = [];
          const viewDetailsLinks = Array.from(document.querySelectorAll('a')).filter(a => a.innerText.toLowerCase().includes('view detail'));

          viewDetailsLinks.forEach(link => {
            const href = link.href;
            let card = link.closest('div[class*="card"], div[class*="box"], article') || link.parentElement.parentElement;
            if (card) {
              const titleEl = card.querySelector('h2, h3, h4, h5, strong');
              let title = titleEl ? titleEl.innerText.trim() : '';
              if (title && title.length > 3 && !title.toLowerCase().includes('get in touch') && !title.toLowerCase().includes('find your course')) {
                const catName = urlStr.split('/').filter(Boolean).pop();
                extracted.push({ title: title, course_url: href, category: catName });
              }
            }
          });
          return extracted;
        }, catUrl);

        courses.forEach(c => allExtractedCourses.set(c.course_url, c));
      } catch (e) { }
    }

    totalCoursesFound = allExtractedCourses.size;
    console.log(`   ✅ Datacouch Phase 1 Complete. Base courses found: ${totalCoursesFound}`);

    console.log(`   🔍 PHASE 2: Deep Scraping Datacouch Course pages...`);
    let count = 1;
    for (const [url, course] of allExtractedCourses.entries()) {
        try {
            console.log(`      [${count}/${totalCoursesFound}] Extracting tabs for: ${course.title}`);
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(2000); 

            let combinedDetails = [];
            const tabs = page.locator('.elementkit-nav-link');
            const tabCount = await tabs.count();

            if (tabCount > 0) {
                for (let i = 0; i < tabCount; i++) {
                    try {
                        const tab = tabs.nth(i);
                        if (await tab.isVisible()) {
                            await tab.click({ force: true });
                            await page.waitForTimeout(1000); 
                            const targetId = await tab.getAttribute('data-target') || await tab.getAttribute('href');
                            const tabTitle = await tab.innerText() || await tab.textContent();
                            
                            if (targetId && targetId.startsWith('#') && tabTitle) {
                                const cleanTitle = tabTitle.trim();
                                await page.evaluate((selector) => {
                                    const pane = document.querySelector(selector);
                                    if (pane) {
                                        const togglers = pane.querySelectorAll('.ekit-accordion--toggler, [data-ekit-toggle="collapse"]');
                                        togglers.forEach(btn => { if (btn.getAttribute('aria-expanded') === 'false' || btn.classList.contains('collapsed')) btn.click(); });
                                    }
                                }, targetId);

                                await page.waitForTimeout(1000);

                                const paneText = await page.evaluate((selector) => {
                                    const pane = document.querySelector(selector);
                                    if (!pane) return '';
                                    return pane.innerText.trim();
                                }, targetId);

                                if (paneText && paneText.length > 5) combinedDetails.push(`${cleanTitle}:\n${paneText}`);
                            }
                        }
                    } catch (tabErr) {}
                }
            } else {
                const fallbackText = await page.evaluate(() => {
                    const togglers = document.querySelectorAll('.ekit-accordion--toggler');
                    togglers.forEach(btn => { if(btn.getAttribute('aria-expanded') === 'false') btn.click(); });
                    return new Promise(resolve => {
                        setTimeout(() => {
                            const accordions = document.querySelector('.ekit-accordion');
                            resolve(accordions ? 'Curriculum:\n' + accordions.innerText.trim() : 'No detailed course information available');
                        }, 1000);
                    });
                });
                if (fallbackText !== 'No detailed course information available') combinedDetails.push(fallbackText);
            }
            course.description = combinedDetails.length > 0 ? combinedDetails.join('\n\n---------------------------\n\n') : 'No detailed course information available';
        } catch (e) {
            course.description = 'Extraction failed';
        }
        count++;
    }

    if (browser) { await browser.close(); browser = null; }

    console.log(`✅ Datacouch Scrape Complete. Found: ${totalCoursesFound}`);
    console.log(`   ⏳ Syncing to Supabase Database...`);

    let dbCount = 0;
    for (const [url, course] of allExtractedCourses.entries()) {
      dbCount++;
      if (dbCount % 50 === 0) console.log(`      💾 Synced ${dbCount}/${totalCoursesFound} to database...`);
      const { data: existing } = await supabase.from('courses').select('id, description').eq('competitor_id', comp.id).eq('course_url', course.course_url).single();
      
      if (!existing) {
        await supabase.from('courses').insert({ ...withType(course), competitor_id: comp.id });
        detectedChanges.newCourses.push(course);
      } else {
        if (existing.description && existing.description !== 'Extraction failed' && existing.description !== course.description) {
            detectedChanges.modifiedCourses.push(course);
            await supabase.from('courses').update({ description: course.description, last_modified_at: new Date().toISOString(), last_seen_at: new Date().toISOString() }).eq('id', existing.id);
        } else {
            await supabase.from('courses').update({ last_seen_at: new Date().toISOString() }).eq('id', existing.id);
        }
      }
    }
    syncStatus = 'SUCCESS';

  } catch (error) {
    console.error('❌ Datacouch Scraping failed:', error);
  } finally {
    if (browser) await browser.close();
    await supabase.from('sync_logs').insert({ competitor_id: comp.id, status: syncStatus, courses_found: totalCoursesFound, new_courses_added: detectedChanges.newCourses.length });
    return { status: syncStatus, totalCoursesFound, newCourses: detectedChanges.newCourses, modifiedCourses: detectedChanges.modifiedCourses };
  }
}

// ==========================================
// 4. SONATYPE SCRAPER
// ==========================================
async function scrapeSonatype() {
  console.log('🚀 Starting Sonatype Scraper...');
  let browser, syncStatus = 'FAILED', totalCoursesFound = 0;
  let detectedChanges = { newCourses: [], modifiedCourses: [] };

  const { data: comp } = await supabase.from('competitors').select('*').eq('name', 'Sonatype').single();
  if (!comp) return { status: 'FAILED', error: 'Not found in DB' };

  try {
    browser = await chromium.launch(BROWSER_CONFIG);
    const context = await browser.newContext(VIEWPORT_CONFIG);
    const page = await context.newPage();
    const allExtractedContent = new Map();
    const normalizeUrl = (href) => href.startsWith('http') ? href : `https://www.sonatype.com${href}`;

    const sonatypeConfigs = [
        { urlTemplate: 'https://www.sonatype.com/resources?category=all&type=all&page=', pages: 16, category: 'Resource' },
        { urlTemplate: 'https://www.sonatype.com/blog?category=all&type=all&page=', pages: 17, category: 'Blog' },
        { urlTemplate: 'https://www.sonatype.com/resources?category=all&type=webinars&page=', pages: 6, category: 'Webinar' },
        { urlTemplate: 'https://www.sonatype.com/resources?type=research&page=', pages: 1, category: 'Research' }
    ];

    for (const config of sonatypeConfigs) {
        for (let p = 1; p <= config.pages; p++) {
            const targetUrl = `${config.urlTemplate}${p}`;
            try {
                await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
                await page.waitForTimeout(2000); 

                const items = await page.evaluate(({ category }) => {
                    const extracted = [];
                    document.querySelectorAll('a').forEach(a => {
                        const href = a.getAttribute('href');
                        let titleAttr = a.getAttribute('title') || '';
                        let innerText = a.innerText.trim();

                        if (href && !href.includes('javascript:') && !href.includes('#')) {
                            if (titleAttr.includes('Internal link to')) {
                                let cleanTitle = titleAttr.replace('Internal link to ', '').replace(' resource', '').trim();
                                extracted.push({ title: cleanTitle, url: href, category: category });
                            } 
                            else if (innerText.length > 10 && (href.includes('/blog/') || href.includes('/resources/'))) {
                                extracted.push({ title: innerText, url: href, category: category });
                            }
                        }
                    });
                    return extracted;
                }, { category: config.category });

                items.forEach(item => {
                    allExtractedContent.set(normalizeUrl(item.url), { title: item.title, course_url: normalizeUrl(item.url), category: item.category, description: `Sonatype ${item.category}` });
                });
            } catch (err) {}
        }
    }

    if (browser) { await browser.close(); browser = null; }

    totalCoursesFound = allExtractedContent.size;
    console.log(`✅ Sonatype Scrape Complete. Found: ${totalCoursesFound}`);
    console.log(`   ⏳ Syncing to Supabase Database...`);

    let dbCount = 0;
    for (const [url, item] of allExtractedContent.entries()) {
        dbCount++;
        if (dbCount % 100 === 0) console.log(`      💾 Synced ${dbCount}/${totalCoursesFound} to database...`);
        const { data: existing } = await supabase.from('courses').select('id, description').eq('competitor_id', comp.id).eq('course_url', item.course_url).single();
        if (!existing) {
          await supabase.from('courses').insert({ ...withType(item), competitor_id: comp.id });
          detectedChanges.newCourses.push(item);
        } else {
          await supabase.from('courses').update({ last_seen_at: new Date().toISOString() }).eq('id', existing.id);
        }
    }
    syncStatus = 'SUCCESS';
  } catch (error) {
    console.error('❌ Sonatype Scraping failed:', error);
  } finally {
    if (browser) await browser.close();
    await supabase.from('sync_logs').insert({ competitor_id: comp.id, status: syncStatus, courses_found: totalCoursesFound, new_courses_added: detectedChanges.newCourses.length });
    return { status: syncStatus, totalCoursesFound, newCourses: detectedChanges.newCourses, modifiedCourses: detectedChanges.modifiedCourses };
  }
}

// ==========================================
// 5. TRAINOCATE SCRAPER
// ==========================================
async function scrapeTrainocate() {
  console.log('🚀 Starting Trainocate Scraper...');
  let browser, syncStatus = 'FAILED', totalCoursesFound = 0;
  let detectedChanges = { newCourses: [], modifiedCourses: [] };

  const { data: comp } = await supabase.from('competitors').select('*').eq('name', 'Trainocate').single();
  if (!comp) return { status: 'FAILED', error: 'Not found in DB' };

  try {
    browser = await chromium.launch(BROWSER_CONFIG);
    const context = await browser.newContext(VIEWPORT_CONFIG);
    const page = await context.newPage();
    const allExtractedContent = new Map();

    const normalizeUrl = (href) => {
        try { return new URL(href, 'https://trainocate.com').href; } 
        catch(e) { return `https://trainocate.com${href.startsWith('/') ? '' : '/'}${href}`; }
    };

    const trainocateCategories = [
        '/in/courses/a10', '/in/courses/alibaba-cloud', '/in/courses/aws',
        '/in/courses/blockchain', '/in/courses/business-it', '/in/courses/cisco',
        '/in/courses/comptia', '/in/courses/cybersecurity', '/in/courses/dell-emc',
        '/in/courses/databricks', '/in/courses/devops-institute', '/in/courses/ec-council',
        '/in/courses/exin', '/in/courses/fortinet', '/in/courses/google-cloud-platform',
        '/in/courses/isaca', '/in/courses/isc2', '/in/courses/itil',
        '/in/courses/microsoft', '/in/courses/netapp', '/in/courses/nutanix',
        '/in/courses/oracle', '/in/courses/palo-alto-networks', '/in/courses/peoplecert',
        '/in/courses/rocheston', '/in/courses/scrum-org', '/in/courses/snowflake',
        '/in/courses/splunk', '/in/courses/techx', '/in/courses/trend-micro',
        '/in/courses/vmware'
    ];

    for (const catPath of trainocateCategories) {
        const catUrl = `https://trainocate.com${catPath}`;
        try {
            await page.goto(catUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await page.waitForTimeout(2000);

            let hasMore = true, loadCount = 0;
            while (hasMore && loadCount < 50) { 
                try {
                    const loadBtn = page.locator('#ContentPlaceHolder1_btnLoadMoreCourses');
                    if (await loadBtn.isVisible()) {
                        await loadBtn.click({ force: true });
                        await page.waitForTimeout(3000); 
                        loadCount++;
                    } else { hasMore = false; }
                } catch (e) { hasMore = false; }
            }

            const courses = await page.evaluate((categoryName) => {
                const extracted = [];
                document.querySelectorAll('h3').forEach(h3 => {
                    const link = h3.querySelector('a');
                    if (link) {
                        const href = link.getAttribute('href');
                        let titleText = h3.innerText.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
                        if (href && href.includes('/courses/') && titleText.length > 3) {
                            extracted.push({ title: titleText, url: href, category: categoryName });
                        }
                    }
                });
                return extracted;
            }, catPath.replace('/in/courses/', '').toUpperCase());

            courses.forEach(c => {
                const absoluteUrl = normalizeUrl(c.url);
                allExtractedContent.set(absoluteUrl, { title: c.title, course_url: absoluteUrl, category: c.category, description: `Trainocate Category: ${c.category}` });
            });
        } catch (e) {}
    }

    try {
        await page.goto('https://blog.trainocate.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(2000);
        let hasMore = true, loadCount = 0;
        while (hasMore && loadCount < 20) {
            try {
                const loadBtn = page.locator('#load-more');
                if (await loadBtn.isVisible()) {
                    await loadBtn.click({ force: true });
                    await page.waitForTimeout(2000);
                    loadCount++;
                } else { hasMore = false; }
            } catch (e) { hasMore = false; }
        }

        const blogs = await page.evaluate(() => {
            const extracted = [];
            document.querySelectorAll('h3.group-hover\\:text-trn-primary').forEach(h3 => {
                const a = h3.closest('a');
                if (a && a.href) extracted.push({ title: h3.innerText.trim(), url: a.getAttribute('href'), category: 'Blog' });
            });
            return extracted;
        });

        blogs.forEach(b => {
            const absoluteUrl = normalizeUrl(b.url);
            allExtractedContent.set(absoluteUrl, { title: b.title, course_url: absoluteUrl, category: b.category, description: `Trainocate Blog` });
        });
    } catch (e) {}

    try {
        await page.goto('https://trainocate.com/in/events', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(2000);
        
        const events = await page.evaluate(() => {
            const extracted = [];
            document.querySelectorAll('span[id*="lblPromoTitle"]').forEach(span => {
                const a = span.closest('a') || span.parentElement;
                let href = a && a.hasAttribute('href') ? a.getAttribute('href') : window.location.href;
                if (href === window.location.href) href = window.location.href + '#' + encodeURIComponent(span.innerText.trim().substring(0, 20));
                extracted.push({ title: span.innerText.trim(), url: href, category: 'Event' });
            });
            return extracted;
        });

        events.forEach(e => {
            const absoluteUrl = normalizeUrl(e.url);
            allExtractedContent.set(absoluteUrl, { title: e.title, course_url: absoluteUrl, category: e.category, description: `Trainocate Event` });
        });
    } catch (e) {}

    if (browser) { await browser.close(); browser = null; }

    totalCoursesFound = allExtractedContent.size;
    console.log(`✅ Trainocate Scrape Complete. Found: ${totalCoursesFound}`);
    console.log(`   ⏳ Syncing to Supabase Database...`);

    let dbCount = 0;
    for (const [url, course] of allExtractedContent.entries()) {
      dbCount++;
      if (dbCount % 100 === 0) console.log(`      💾 Synced ${dbCount}/${totalCoursesFound} to database...`);
      const { data: existing } = await supabase.from('courses').select('id, description').eq('competitor_id', comp.id).eq('course_url', course.course_url).single();
      
      if (!existing) {
        await supabase.from('courses').insert({ ...withType(course), competitor_id: comp.id });
        detectedChanges.newCourses.push(course);
      } else {
        if (existing.description && existing.description !== course.description) {
            detectedChanges.modifiedCourses.push(course);
            await supabase.from('courses').update({ description: course.description, last_modified_at: new Date().toISOString(), last_seen_at: new Date().toISOString() }).eq('id', existing.id);
        } else {
            await supabase.from('courses').update({ last_seen_at: new Date().toISOString() }).eq('id', existing.id);
        }
      }
    }
    syncStatus = 'SUCCESS';

  } catch (error) {
    console.error('❌ Trainocate Scraping failed:', error);
  } finally {
    if (browser) await browser.close();
    await supabase.from('sync_logs').insert({ competitor_id: comp.id, status: syncStatus, courses_found: totalCoursesFound, new_courses_added: detectedChanges.newCourses.length });
    return { status: syncStatus, totalCoursesFound, newCourses: detectedChanges.newCourses, modifiedCourses: detectedChanges.modifiedCourses };
  }
}

// ==========================================
// 6. GENERAL ASSEMBLY SCRAPER
// ==========================================
async function scrapeGeneralAssembly() {
  console.log('🚀 Starting General Assembly Scraper...');
  let browser, syncStatus = 'FAILED', totalCoursesFound = 0;
  let detectedChanges = { newCourses: [], modifiedCourses: [] };

  const { data: comp } = await supabase.from('competitors').select('*').eq('name', 'General Assembly').single();
  if (!comp) return { status: 'FAILED', error: 'Not found in DB' };

  try {
    browser = await chromium.launch(BROWSER_CONFIG);
    const context = await browser.newContext(VIEWPORT_CONFIG);
    const page = await context.newPage();
    const allExtractedCourses = new Map();
    const normalizeUrl = (href) => href.startsWith('http') ? href : `https://generalassemb.ly${href}`;

    console.log(`   👉 Visiting General Assembly: Courses`);
    await page.goto(comp.base_url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    let hasMore = true, loadCount = 0;
    while (hasMore && loadCount < 20) {
        try {
            const loadBtn = page.locator('a[class*="loadMoreButton"], button:has-text("Load More")').last();
            if (await loadBtn.isVisible()) {
                await loadBtn.click({ force: true });
                await page.waitForTimeout(3000);
                loadCount++;
            } else { hasMore = false; }
        } catch (e) { hasMore = false; }
    }

    const courses = await page.evaluate(() => {
        const extracted = [];
        document.querySelectorAll('div[class*="programOverviewCard_cardBody"]').forEach(card => {
            const titleNode = card.querySelector('h5');
            const linkNode = card.querySelector('a[class*="programOverviewCard_cardLink"]');
            if (titleNode && linkNode) {
                extracted.push({ title: titleNode.innerText.trim(), url: linkNode.getAttribute('href'), category: 'Course' });
            }
        });
        return extracted;
    });

    courses.forEach(c => {
        const absoluteUrl = normalizeUrl(c.url);
        allExtractedCourses.set(absoluteUrl, { title: c.title, course_url: absoluteUrl, category: c.category, description: 'General Assembly Course' });
    });

    console.log(`   👉 Visiting General Assembly: Blogs`);
    try {
        await page.goto('https://generalassemb.ly/blog/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000);
        
        const blogs = await page.evaluate(() => {
            const extracted = [];
            document.querySelectorAll('h3.font-tertiary.uppercase.font-bold').forEach(h3 => {
                const title = h3.innerText.trim();
                const a = h3.closest('a');
                if (a && a.getAttribute('href') && title) {
                    extracted.push({ title, url: a.getAttribute('href'), category: 'Blog' });
                }
            });
            return extracted;
        });

        blogs.forEach(c => {
            const absoluteUrl = normalizeUrl(c.url);
            allExtractedCourses.set(absoluteUrl, { title: c.title, course_url: absoluteUrl, category: c.category, description: 'General Assembly Blog' });
        });
    } catch(e) {
        console.log("      ⚠️ Failed to load GA Blogs");
    }

    if (browser) { await browser.close(); browser = null; }

    totalCoursesFound = allExtractedCourses.size;
    console.log(`✅ General Assembly Scrape Complete. Found: ${totalCoursesFound}`);
    console.log(`   ⏳ Syncing to Supabase Database...`);

    let dbCount = 0;
    for (const [url, item] of allExtractedCourses.entries()) {
        dbCount++;
        if (dbCount % 100 === 0) console.log(`      💾 Synced ${dbCount}/${totalCoursesFound} to database...`);
        const { data: existing } = await supabase.from('courses').select('id, description').eq('competitor_id', comp.id).eq('course_url', item.course_url).single();
        if (!existing) {
            await supabase.from('courses').insert({ ...withType(item), competitor_id: comp.id });
            detectedChanges.newCourses.push(item);
        } else {
            await supabase.from('courses').update({ last_seen_at: new Date().toISOString() }).eq('id', existing.id);
        }
    }
    syncStatus = 'SUCCESS';

  } catch (error) {
    console.error('❌ General Assembly Scraping failed:', error);
  } finally {
    if (browser) await browser.close();
    await supabase.from('sync_logs').insert({ competitor_id: comp.id, status: syncStatus, courses_found: totalCoursesFound, new_courses_added: detectedChanges.newCourses.length });
    return { status: syncStatus, totalCoursesFound, newCourses: detectedChanges.newCourses, modifiedCourses: detectedChanges.modifiedCourses };
  }
}

// ==========================================
// 7. CLOUDTHAT SCRAPER
// ==========================================
async function scrapeCloudThat() {
  console.log('🚀 Starting CloudThat Scraper...');
  let browser, syncStatus = 'FAILED', totalCoursesFound = 0;
  let detectedChanges = { newCourses: [], modifiedCourses: [] };

  const { data: comp } = await supabase.from('competitors').select('*').eq('name', 'CloudThat').single();
  if (!comp) return { status: 'FAILED', error: 'Not found in DB' };

  try {
    browser = await chromium.launch(BROWSER_CONFIG);
    const context = await browser.newContext(VIEWPORT_CONFIG);
    const page = await context.newPage();
    const allExtractedContent = new Map();
    const normalizeUrl = (href) => href.startsWith('http') ? href : `https://www.cloudthat.com${href}`;

    const categories = [
        '/training/ai-machine-learning-certification-course', '/training/aws/', '/training/azure',
        '/training/databricks', '/training/devops/', '/training/full-stack-development/',
        '/training/google-cloud-certification', '/training/iot/', '/training/microsoftdynamics/',
        '/training/microsoft-office/', '/training/microsoft-security/', '/training/modernworkplace/',
        '/training/nvidia-certification-course', '/training/power-platform/', '/training/vmware/'
    ];

    console.log(`   🔍 PHASE 1: Scanning ${categories.length} CloudThat Course Pages...`);
    for (const catPath of categories) {
        const catUrl = `https://www.cloudthat.com${catPath}`;
        try {
            await page.goto(catUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await page.waitForTimeout(2000);

            let hasMore = true, loadCount = 0;
            while (hasMore && loadCount < 10) { 
                try {
                    const loadBtn = page.locator('#load-more-courses');
                    if (await loadBtn.isVisible()) {
                        await loadBtn.click({ force: true });
                        await page.waitForTimeout(2000); 
                        loadCount++;
                    } else { hasMore = false; }
                } catch (e) { hasMore = false; }
            }

            const courses = await page.evaluate((categoryName) => {
                const extracted = [];
                document.querySelectorAll('.course_details h4').forEach(h4 => {
                    const title = h4.innerText.trim();
                    const a = h4.closest('a');
                    let href = a ? a.getAttribute('href') : null;
                    if (!href) href = window.location.href + '#' + encodeURIComponent(title);
                    
                    const descNode = h4.parentElement.querySelector('p');
                    const desc = descNode ? descNode.innerText.trim() : 'CloudThat Course';

                    if (title && title.length > 3) {
                        extracted.push({ title, url: href, category: categoryName, description: desc });
                    }
                });
                return extracted;
            }, catPath.replace('/training/', '').replace(/\//g, '').toUpperCase());

            courses.forEach(c => {
                const absoluteUrl = normalizeUrl(c.url);
                allExtractedContent.set(absoluteUrl, { title: c.title, course_url: absoluteUrl, category: c.category, description: c.description });
            });
        } catch (e) {}
    }

    console.log(`   🔍 PHASE 2: Scanning CloudThat Blogs (Pages 1-3)...`);
    for (let p = 1; p <= 3; p++) {
        const blogUrl = p === 1 ? 'https://www.cloudthat.com/resources/blogs/' : `https://www.cloudthat.com/resources/blogs/page/${p}/`;
        try {
            await page.goto(blogUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await page.waitForTimeout(2000);
            
            const blogs = await page.evaluate(() => {
                const extracted = [];
                document.querySelectorAll('.blog_evt_cont h3 a').forEach(a => {
                    extracted.push({ title: a.innerText.trim(), url: a.getAttribute('href'), category: 'Blog' });
                });
                return extracted;
            });

            blogs.forEach(b => {
                const absoluteUrl = normalizeUrl(b.url);
                allExtractedContent.set(absoluteUrl, { title: b.title, course_url: absoluteUrl, category: b.category, description: 'CloudThat Blog' });
            });
        } catch(e) {}
    }

    if (browser) { await browser.close(); browser = null; }

    totalCoursesFound = allExtractedContent.size;
    console.log(`✅ CloudThat Scrape Complete. Found: ${totalCoursesFound}`);
    console.log(`   ⏳ Syncing to Supabase Database...`);

    let dbCount = 0;
    for (const [url, course] of allExtractedContent.entries()) {
      dbCount++;
      if (dbCount % 100 === 0) console.log(`      💾 Synced ${dbCount}/${totalCoursesFound} to database...`);
      const { data: existing } = await supabase.from('courses').select('id, description').eq('competitor_id', comp.id).eq('course_url', course.course_url).single();
      if (!existing) {
        await supabase.from('courses').insert({ ...withType(course), competitor_id: comp.id });
        detectedChanges.newCourses.push(course);
      } else {
        if (existing.description && existing.description !== course.description) {
            detectedChanges.modifiedCourses.push(course);
            await supabase.from('courses').update({ description: course.description, last_modified_at: new Date().toISOString(), last_seen_at: new Date().toISOString() }).eq('id', existing.id);
        } else {
            await supabase.from('courses').update({ last_seen_at: new Date().toISOString() }).eq('id', existing.id);
        }
      }
    }
    syncStatus = 'SUCCESS';

  } catch (error) {
    console.error('❌ CloudThat Scraping failed:', error);
  } finally {
    if (browser) await browser.close();
    await supabase.from('sync_logs').insert({ competitor_id: comp.id, status: syncStatus, courses_found: totalCoursesFound, new_courses_added: detectedChanges.newCourses.length });
    return { status: syncStatus, totalCoursesFound, newCourses: detectedChanges.newCourses, modifiedCourses: detectedChanges.modifiedCourses };
  }
}

// ==========================================
// 8. NETCOM LEARNING SCRAPER
// ==========================================
async function scrapeNetcomLearning() {
  console.log('🚀 Starting NetCom Learning Scraper...');
  let browser, syncStatus = 'FAILED', totalCoursesFound = 0;
  let detectedChanges = { newCourses: [], modifiedCourses: [] };

  const { data: comp } = await supabase.from('competitors').select('*').eq('name', 'NetCom Learning').single();
  if (!comp) return { status: 'FAILED', error: 'Not found in DB' };

  try {
    browser = await chromium.launch(BROWSER_CONFIG);
    const context = await browser.newContext(VIEWPORT_CONFIG);
    const page = await context.newPage();
    const allExtractedContent = new Map();
    const normalizeUrl = (href) => href.startsWith('http') ? href : `https://www.netcomlearning.com${href}`;

    const categories = [
        '/skilling-page/ai-and-data', '/skilling-page/cloud', '/skilling-page/security',
        '/skilling-page/networking', '/skilling-page/application-development', '/skilling-page/architecture-and-design',
        '/skilling-page/business-applications', '/skilling-page/business-process', '/skilling-page/business-and-leadership'
    ];

    console.log(`   🔍 PHASE 1: Scanning ${categories.length} NetCom Course Pages...`);
    for (const catPath of categories) {
        const catUrl = `https://www.netcomlearning.com${catPath}`;
        try {
            await page.goto(catUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await page.waitForTimeout(3000); 

            const courses = await page.evaluate((categoryName) => {
                const extracted = [];
                document.querySelectorAll('.course-title-with-skill-badge h4, .card-info h4').forEach(h4 => {
                    const title = h4.innerText.trim();
                    const a = h4.closest('a');
                    let href = a ? a.getAttribute('href') : null;
                    if (!href) href = window.location.href + '#' + encodeURIComponent(title);
                    
                    if (title && title.length > 3) {
                        extracted.push({ title, url: href, category: categoryName, description: 'NetCom Learning Course' });
                    }
                });
                return extracted;
            }, catPath.replace('/skilling-page/', '').replace(/-/g, ' ').toUpperCase());

            courses.forEach(c => {
                const absoluteUrl = normalizeUrl(c.url);
                allExtractedContent.set(absoluteUrl, { title: c.title, course_url: absoluteUrl, category: c.category, description: c.description });
            });
        } catch (e) {}
    }

    console.log(`   🔍 PHASE 2: Scanning NetCom Blogs (Pages 1-3) via Ant-Design Pagination...`);
    try {
        await page.goto('https://www.netcomlearning.com/blogs', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(3000);

        for (let p = 1; p <= 3; p++) {
            try {
                if (p > 1) {
                    const pageBtn = page.locator(`li[title="${p}"]`).first();
                    if (await pageBtn.isVisible({ timeout: 5000 })) {
                        await pageBtn.click({ force: true, timeout: 5000 });
                        await page.waitForTimeout(3000); 
                    } else break;
                }
            } catch (clickErr) { break; } // Safe break if pagination button is missing

            const blogs = await page.evaluate(() => {
                const extracted = [];
                document.querySelectorAll('.card-info h4').forEach(h4 => {
                    const a = h4.closest('a');
                    let href = a ? a.getAttribute('href') : null;
                    if (!href) href = window.location.href + '#' + encodeURIComponent(h4.innerText.trim());
                    extracted.push({ title: h4.innerText.trim(), url: href, category: 'Blog' });
                });
                return extracted;
            });

            blogs.forEach(b => {
                const absoluteUrl = normalizeUrl(b.url);
                allExtractedContent.set(absoluteUrl, { title: b.title, course_url: absoluteUrl, category: b.category, description: 'NetCom Blog' });
            });
        }
    } catch(e) {}

    console.log(`   🔍 PHASE 3: Scanning NetCom Case Studies (Pages 1-7) via Ant-Design Pagination...`);
    try {
        await page.goto('https://www.netcomlearning.com/case-studies', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(3000);

        for (let p = 1; p <= 7; p++) {
            try {
                if (p > 1) {
                    const pageBtn = page.locator(`li[title="${p}"]`).first();
                    if (await pageBtn.isVisible({ timeout: 5000 })) {
                        await pageBtn.click({ force: true, timeout: 5000 });
                        await page.waitForTimeout(3000); 
                    } else break;
                }
            } catch (clickErr) { break; }

            const cases = await page.evaluate(() => {
                const extracted = [];
                document.querySelectorAll('.card-info h4').forEach(h4 => {
                    const a = h4.closest('a');
                    let href = a ? a.getAttribute('href') : null;
                    if (!href) href = window.location.href + '#' + encodeURIComponent(h4.innerText.trim());
                    extracted.push({ title: h4.innerText.trim(), url: href, category: 'Case Study' });
                });
                return extracted;
            });

            cases.forEach(c => {
                const absoluteUrl = normalizeUrl(c.url);
                allExtractedContent.set(absoluteUrl, { title: c.title, course_url: absoluteUrl, category: c.category, description: 'NetCom Case Study' });
            });
        }
    } catch(e) {}

    if (browser) { await browser.close(); browser = null; }

    totalCoursesFound = allExtractedContent.size;
    console.log(`✅ NetCom Learning Scrape Complete. Found: ${totalCoursesFound}`);
    console.log(`   ⏳ Syncing to Supabase Database... (This may take a few minutes)`);

    let dbCount = 0;
    for (const [url, course] of allExtractedContent.entries()) {
      dbCount++;
      if (dbCount % 100 === 0) console.log(`      💾 Synced ${dbCount}/${totalCoursesFound} to database...`);

      const { data: existing } = await supabase.from('courses').select('id, description').eq('competitor_id', comp.id).eq('course_url', course.course_url).single();
      if (!existing) {
        await supabase.from('courses').insert({ ...withType(course), competitor_id: comp.id });
        detectedChanges.newCourses.push(course);
      } else {
        await supabase.from('courses').update({ last_seen_at: new Date().toISOString() }).eq('id', existing.id);
      }
    }
    syncStatus = 'SUCCESS';

  } catch (error) {
    console.error('❌ NetCom Learning Scraping failed:', error);
  } finally {
    if (browser) await browser.close();
    await supabase.from('sync_logs').insert({ competitor_id: comp.id, status: syncStatus, courses_found: totalCoursesFound, new_courses_added: detectedChanges.newCourses.length });
    return { status: syncStatus, totalCoursesFound, newCourses: detectedChanges.newCourses, modifiedCourses: detectedChanges.modifiedCourses };
  }
}

// ==========================================
// 9. GENERIC CONFIG-DRIVEN SCRAPER ENGINE
// ==========================================
// Drives any competitor whose `config` column describes its page structure
// (itemContainer/link/title/category/description selectors + a pagination
// strategy) instead of a hand-written function per site. Competitors that use
// this engine are flagged with auto_detected = true.

function inferCategory(url) {
  let p = '';
  try { p = new URL(url).pathname.toLowerCase(); } catch (_) {}
  if (/blog/.test(p)) return 'Blog';
  if (/webinar/.test(p)) return 'Webinar';
  if (/event/.test(p)) return 'Event';
  if (/case-stud/.test(p)) return 'Case Study';
  if (/guide|tutorial/.test(p)) return 'Guide';
  if (/resource/.test(p)) return 'Resource';
  if (/course|training|learn|certif|program|academy/.test(p)) return 'Course';
  return 'Other';
}

async function extractItemsFromPage(page, source) {
  return await page.evaluate(({ itemContainer, selectors }) => {
    const out = [];
    document.querySelectorAll(itemContainer).forEach((container) => {
      const link = selectors.link === 'self' ? container : container.querySelector(selectors.link);
      if (!link) return;
      const href = link.getAttribute ? (link.getAttribute('href') || link.href) : link.href;
      if (!href || href.includes('javascript:')) return;

      const catEl = selectors.category ? container.querySelector(selectors.category) : null;
      const category = catEl ? catEl.innerText.trim() : null;

      const titleEl = selectors.title ? container.querySelector(selectors.title) : null;
      let title = (titleEl ? titleEl.innerText : link.innerText || '').trim();
      // Some card templates nest the category badge / date line inside the same
      // heading element as the title (common when link === 'self'). Strip any
      // leading lines that just repeat the category or look like a bare date,
      // rather than assuming every site's markup cleanly isolates the title.
      const lines = title.split('\n').map(l => l.trim()).filter(Boolean);
      while (lines.length > 1) {
        const first = lines[0].toLowerCase();
        const isCategoryLine = category && first === category.trim().toLowerCase();
        const isDateLine = /^[a-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}$/i.test(lines[0]);
        if (isCategoryLine || isDateLine) lines.shift();
        else break;
      }
      title = lines.join(' ').trim();
      if (!title || title.length < 3) return;

      const descEl = selectors.description ? container.querySelector(selectors.description) : null;
      const description = descEl ? descEl.innerText.trim() : null;

      out.push({ href, title, category, description });
    });
    return out;
  }, { itemContainer: source.itemContainer, selectors: source.selectors });
}


function classifyGenericContent(title = '', url = '', description = '') {
  const titleText = String(title || '').trim().toLowerCase();
  const urlText = String(url || '').trim().toLowerCase();
  const descText = String(description || '').trim().toLowerCase();

  // Generic navigation / utility pages: never track as content.
  const utilityTitle =
    /^(buy for my team|skip to main content|see all|view all|learn more|read more|show more|load more|back|next|previous|home|menu|search|close|open|sign in|sign up|login|log in|register|contact us|about us|privacy policy|terms|terms of use|careers|support|help)$/i;

  const utilityUrl =
    /\/(contact|about|privacy|terms|careers|login|signin|sign-in|signup|sign-up|register|checkout|cart|account|search|sitemap)(\/|$)/i;

  if (utilityTitle.test(titleText) || utilityUrl.test(urlText)) {
    return null;
  }

  // Strong URL structure signals.
  if (/\/(topics?|subjects?|subject-areas?|skills?|domains?)\//i.test(urlText)) {
    return 'Topic';
  }

  if (/\/(courses?|classes?|programs?|learning-paths?|curriculums?)\//i.test(urlText)) {
    return 'Course';
  }

  if (/\/(certificates?|certifications?|credentials?|professional-certificates?)\//i.test(urlText)) {
    return 'Certification';
  }

  if (/\/(webinars?|online-events?)\//i.test(urlText)) {
    return 'Webinar';
  }

  if (/\/(workshops?|hands-on-workshops?)\//i.test(urlText)) {
    return 'Workshop';
  }

  if (/\/(events?|conferences?|summits?|meetups?)\//i.test(urlText)) {
    return 'Event';
  }

  if (/\/(tutorials?|how-to)\//i.test(urlText)) {
    return 'Tutorial';
  }

  if (/\/(resources?|whitepapers?|ebooks?|reports?|guides?)\//i.test(urlText)) {
    return 'Resource';
  }

  if (/\/(blogs?|articles?|news)\//i.test(urlText)) {
    return 'Blog / Article';
  }

  const text = `${titleText} ${descText}`;

  // Strong content signals.
  if (
    /\b(course|courses|class|classes|curriculum|lesson|module|courseware)\b/i.test(text) ||
    /\b(enroll|enrollment|start learning|learn at your own pace)\b/i.test(text)
  ) {
    return 'Course';
  }

  if (/certif|credential|exam\s+prep|professional\s+certificate/i.test(text)) {
    return 'Certification';
  }

  if (/webinar|online\s+seminar|virtual\s+(session|event)/i.test(text)) {
    return 'Webinar';
  }

  if (/workshop|hands[-\s]?on\s+workshop/i.test(text)) {
    return 'Workshop';
  }

  if (/\bevent\b|conference|summit|meetup|bootcamp/i.test(text)) {
    return 'Event';
  }

  if (/tutorial|how[-\s]to|step[-\s]by[-\s]step/i.test(text)) {
    return 'Tutorial';
  }

  if (/resource|whitepaper|white\s+paper|ebook|e-book|report|guide/i.test(text)) {
    return 'Resource';
  }

  if (/blog\s+post|article|news/i.test(text)) {
    return 'Blog / Article';
  }

  // No reliable evidence = Other.
  // Never guess Topic/Blog/Course from a short title alone.
  return 'Other';
}

async function scrapeGenericSource(page, source, allItems) {
  const normalizeUrl = (href) => {
    try { return new URL(href, source.baseUrl).href; } catch (e) { return href; }
  };
  const addAll = (extracted) => {
    extracted.forEach((it) => {
      const url = normalizeUrl(it.href);
      if (!url) return;

      const detectedType = classifyGenericContent(
        it.title,
        url,
        it.description
      );

      if (!detectedType) return;

      allItems.set(url, {
        title: it.title,
        course_url: url,
        category: detectedType,
        description: it.description || null
      });
    });
  };

  const pag = source.pagination || { type: 'none' };

  if (pag.type === 'url-pages') {
    const maxPages = pag.maxPages || 5;
    for (let p = 1; p <= maxPages; p++) {
      const url = source.baseUrl.replace('{page}', p);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(1500);
      } catch (e) { break; }
      const extracted = await extractItemsFromPage(page, source).catch(() => []);
      if (extracted.length === 0) break;
      addAll(extracted);
    }
    return;
  }

  try {
    await page.goto(source.baseUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1500);
  } catch (e) { return; }

  if (pag.type === 'next-page') {
    const maxPages = pag.maxPages || 5;
    for (let p = 0; p < maxPages; p++) {
      const extracted = await extractItemsFromPage(page, source).catch(() => []);
      addAll(extracted);
      try {
        const nextLink = page.locator(pag.selector).first();
        if (await nextLink.isVisible({ timeout: 3000 })) {
          await nextLink.click();
          await page.waitForTimeout(2000);
        } else break;
      } catch (e) { break; }
    }
  } else if (pag.type === 'load-more') {
    let loadCount = 0;
    const maxClicks = pag.maxClicks || 8;
    while (loadCount < maxClicks) {
      try {
        const btn = pag.textSelector
          ? page.locator(`button:has-text("${pag.textSelector}"), a:has-text("${pag.textSelector}")`).last()
          : page.locator(pag.selector).last();
        if (await btn.isVisible({ timeout: 3000 })) {
          await btn.click({ force: true });
          await page.waitForTimeout(2000);
          loadCount++;
        } else break;
      } catch (e) { break; }
    }
    addAll(await extractItemsFromPage(page, source).catch(() => []));
  } else if (pag.type === 'scroll') {
    for (let i = 0; i < (pag.maxScrolls || 6); i++) {
      await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
      await page.waitForTimeout(1000);
    }
    addAll(await extractItemsFromPage(page, source).catch(() => []));
  } else {
    addAll(await extractItemsFromPage(page, source).catch(() => []));
  }
}


// ==========================================
// 9b. GENERIC ENGINE V5 (only for competitors added from the dashboard)
// ==========================================
// Goal: find the main Course / Training / Blog listing pages of a site and save
// ONE row per listing page. The row's "details" = the numbered list of every
// sub-course / item name found on that page. On the next scans the list is
// compared, and the exact added / removed names are reported.
const GENV4 = {
  maxListings: 45,          // max listing pages opened per scan
  maxBlogSections: 2,       // blogs are low priority
  maxPagesPerListing: 8,    // follow "Next" pagination up to this many pages
  maxLoadMore: 20,          // "Load more" clicks / scrolls per page
  maxNames: 400,            // max names stored per listing page
  probeIfCardsAtMost: 25,   // few cards = probably categories -> open them too
  minNames: 3,              // a listing needs at least this many names to be saved
  deadlineMs: 20 * 60 * 1000,
  pageTimeout: 30000
};
const GEN_CHROME_SEL = 'header, nav, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], [class*="breadcrumb" i], [class*="footer" i], [class*="navbar" i]';
const GEN_SKIP_EXT = /\.(pdf|jpe?g|png|gif|svg|webp|zip|xml|json|css|js|mp4|mp3|docx?|xlsx?|pptx?)$/i;
const GEN_SKIP_PATH = /\/(login|signin|sign-in|signup|sign-up|register|account|cart|checkout|privacy|terms|cookies?|careers|contact|search|sitemap|feed|rss|wp-json|wp-content|wp-admin|about|pricing|press|legal|support|help)(\/|$)/i;
const GEN_LOCALE = /^(es|pt|fr|de|it|ja|ko|zh|ru|nl|tr|pl|ar|hi|vi|th|sv|da|fi|nb|cs|el|he|hu|ro|uk|pt-br|zh-cn|zh-tw|es-mx|es-es|fr-fr|de-de)$/;
const GEN_REDIRECT_DENY = /(google|facebook|linkedin|twitter|x\.com|instagram|apple|github|microsoft|okta|auth0|cloudflare|youtube|amazonaws)/i;
const GEN_PEOPLE_GROUP = /^\/(teachers?|instructors?|authors?|speakers?|mentors?|people|team|staff|experts?)$/i;
const GEN_PAGER = /\/(page|p)\/\d+$|\/page-\d+$/i;
const GEN_VAGUE = /^(learn more|read more|view( details| course| training| program| all)?|see (all|more|details)|show more|load more|more|explore|get started|enroll( now)?|details|start( now| learning)?|register( now)?|watch( now)?|next|previous|apply( now)?|download|know more|find out more|menu|search|home|login|log in|sign in|sign up|contact( us)?|about( us)?|skip to .*|buy for my team|reset filters|back)$/i;
const GEN_HISTORY_MARK = '\n\n📝 Change history (latest first):\n';

const genWb = (alts) => new RegExp('(^|[\\/\\-_ ])(' + alts + ')($|[\\/\\-_ ])', 'i');
const GEN_TYPE_RULES = [
  ['Blog', genWb('blogs?|articles?|insights?|news|stories')],
  ['Training', genWb('trainings?|bootcamps?|programs?|learning[- ]paths?|paths?|tracks?|academy|certificat\\w*|techdegrees?')],
  ['Course', genWb('courses?|classes?|library|catalog(?:ue)?|tutorials?|lessons?|curricul\\w*|learn|learning')]
];
function genTypeOf(text) {
  const t = String(text || '');
  for (const [type, re] of GEN_TYPE_RULES) if (re.test(t)) return type;
  return null;
}

function genSlugTitle(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '')
      .replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
  } catch (_) { return ''; }
}

// ---- details block helpers (stored in courses.description) ----
function genSplitDescription(desc) {
  const s = String(desc || '');
  const i = s.indexOf(GEN_HISTORY_MARK);
  if (i < 0) return { block: s, history: [] };
  return {
    block: s.slice(0, i),
    history: s.slice(i + GEN_HISTORY_MARK.length).split('\n').map(x => x.trim()).filter(Boolean)
  };
}
function genNamesBlock(names) {
  return `Sub-courses / Items on this page (${names.length}):\n` + names.map((n, i) => `${i + 1}. ${n}`).join('\n');
}
function genOutlineMap(block) {
  const m = new Map();
  String(block || '').split('\n').forEach(l => {
    const x = l.match(/^\d+\.\s+(.+)$/);
    if (x) m.set(x[1].trim().toLowerCase(), x[1].trim());
  });
  return m;
}
function genDiff(oldBlock, newBlock) {
  const a = genOutlineMap(oldBlock), b = genOutlineMap(newBlock);
  // old empty = first capture, new empty = page did not load properly: neither is a real change
  if (a.size === 0 || b.size === 0) return { added: [], removed: [] };
  const added = [...b].filter(([k]) => !a.has(k)).map(([, v]) => v);
  const removed = [...a].filter(([k]) => !b.has(k)).map(([, v]) => v);
  // most of the list vanished at once = the page loaded only partially, ignore this scan
  if (a.size >= 10 && removed.length > a.size * 0.6) return { added: [], removed: [] };
  return { added, removed };
}
function genNote({ added, removed }) {
  const fmt = (arr) => arr.slice(0, 10).join(', ') + (arr.length > 10 ? ` +${arr.length - 10} more` : '');
  const parts = [];
  if (added.length) parts.push(`➕ Added (${added.length}): ${fmt(added)}`);
  if (removed.length) parts.push(`➖ Removed (${removed.length}): ${fmt(removed)}`);
  return parts.join(' | ');
}

// ---- runs INSIDE the browser (must stay self-contained) ----
function genExtractPage(chromeSel) {
  const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
  const vague = /^(learn more|read more|view( details| course| training| program| all)?|see (all|more|details)|show more|load more|more|explore|get started|enroll( now)?|details|start( now| learning)?|register( now)?|watch( now)?|next|previous|apply( now)?|download|know more|find out more|menu|search|home|login|log in|sign in|sign up|contact( us)?|about( us)?|skip to .*|buy for my team|reset filters|back)$/i;
  const headSel = 'h1,h2,h3,h4,h5,h6,[class*="title" i],[class*="heading" i]';
  const cardSel = 'article, li, [class*="card" i], [class*="tile" i]';
  const meta = (s) => clean(document.querySelector(s)?.content);
  const links = [];
  const next = [];
  const relNext = document.querySelector('link[rel="next"]');
  if (relNext && relNext.href) next.push(relNext.href);

  document.querySelectorAll('a[href]').forEach((a) => {
    const raw = a.getAttribute('href') || '';
    if (!raw || raw.startsWith('#') || /^(javascript|mailto|tel):/i.test(raw)) return;
    const label = clean(a.innerText || '');
    const aria = clean(a.getAttribute('aria-label'));
    if (a.getAttribute('rel') === 'next' || /^(next|next page|older|older posts|›|»|>)$/i.test(label) || /^next/i.test(aria)) next.push(a.href);

    let text = clean(a.querySelector(headSel)?.innerText);
    if (!text || vague.test(text)) {
      text = (a.innerText || '').split('\n').map(clean).find(l => l.length >= 3 && !vague.test(l)) || '';
    }
    if (!text) text = aria || clean(a.getAttribute('title'));
    if (!text || vague.test(text)) {
      const card = a.closest(cardSel);
      if (card && card.querySelectorAll('h1,h2,h3,h4,h5,h6').length <= 2) {
        const ch = clean(card.querySelector(headSel)?.innerText);
        if (ch && !vague.test(ch)) text = ch;
      }
    }
    if (vague.test(text)) text = '';
    links.push({ href: a.href, text: text.slice(0, 200), inChrome: Boolean(a.closest(chromeSel)) });
  });

  const jsonld = [];
  document.querySelectorAll('script[type="application/ld+json"]').forEach((el) => {
    try {
      const data = JSON.parse(el.textContent || '');
      (Array.isArray(data) ? data : [data]).forEach((obj) => {
        if (obj && Array.isArray(obj.itemListElement)) {
          obj.itemListElement.forEach((it) => {
            const node = (it && it.item) || it;
            if (node && node.url && node.name) jsonld.push({ href: node.url, text: clean(node.name) });
          });
        }
      });
    } catch (_) {}
  });

  // outline (only used when a page has no card list, e.g. a single course page)
  const scope = document.querySelector('main, article, [role="main"]') || document.body;
  const outline = [];
  const seen = new Set();
  scope.querySelectorAll('[class*="curriculum" i] :is(h2,h3,h4,h5,h6,summary,button), [class*="syllabus" i] :is(h3,h4,h5,h6,summary,button), [class*="module" i] :is(h3,h4,h5,h6), [class*="lesson" i] :is(h3,h4,h5,h6), summary').forEach((e) => {
    if (e.closest(chromeSel)) return;
    const t = clean((e.innerText || '').split('\n')[0]);
    if (t.length >= 3 && t.length <= 140 && !vague.test(t) && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); outline.push(t); }
  });

  const h1 = clean((scope.querySelector('h1') || document.querySelector('h1'))?.innerText);
  return { h1, ogTitle: meta('meta[property="og:title"]'), docTitle: clean(document.title), links, next, jsonld, outline: outline.slice(0, 200) };
}

// ---- turns the raw links of one page into [{url,title}] cards ----
function genBuildCards(r, pageUrl, normalize, includeChrome) {
  const byHref = new Map();
  const push = (href, text) => {
    const nu = normalize(href, pageUrl);
    if (!nu) return;
    text = String(text || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length < 3 || GEN_VAGUE.test(text)) return;
    if (!byHref.has(nu)) byHref.set(nu, []);
    byHref.get(nu).push(text);
  };
  (r.links || []).forEach(l => { if (includeChrome || !l.inChrome) push(l.href, l.text); });
  (r.jsonld || []).forEach(l => push(l.href, l.text));

  // A card usually has 2 links to the same URL: the title and a truncated description ("...").
  const pick = (texts) => {
    const full = texts.filter(t => !/(\.\.\.|…)$/.test(t) && t.length <= 140);
    if (full.length) return full.sort((a, b) => a.length - b.length)[0];
    return texts[0].replace(/(\.\.\.|…)$/, '').trim().slice(0, 140);
  };

  let curPath = '';
  try { curPath = new URL(pageUrl).pathname.replace(/\/+$/, ''); } catch (_) {}

  const groups = new Map();
  for (const [url, texts] of byHref) {
    let u;
    try { u = new URL(url); } catch (_) { continue; }
    const path = u.pathname.replace(/\/+$/, '');
    if (!path || path === curPath || GEN_PAGER.test(path)) continue;
    const segs = path.split('/').filter(Boolean);
    if (segs.some(s => s.includes(':'))) continue;                 // filter facets like /q:abc
    if (/^\/(tag|tags|author|authors)(\/|$)/i.test(path)) continue;
    const key = segs.length >= 2 ? '/' + segs[0].toLowerCase() : '/';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ url, title: pick(texts), depth: segs.length });
  }

  const cleaned = [];
  for (const [gkey, arr] of groups) {
    if (GEN_PEOPLE_GROUP.test(gkey)) continue;   // teacher / author profile links are not courses
    const cnt = {};
    arr.forEach(i => { cnt[i.depth] = (cnt[i.depth] || 0) + 1; });
    const best = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0];
    let list = arr.filter(i => String(i.depth) === best);
    const uniq0 = new Set(list.map(i => i.title.toLowerCase()));
    if (list.length >= 4 && uniq0.size < list.length * 0.6) {
      // most titles are the same label (e.g. "Beginner"): the link text is not the real title
      list = list.map(i => ({ ...i, title: genSlugTitle(i.url) || i.title }));
    }
    const uniq = new Set(list.map(i => i.title.toLowerCase()));
    if (list.length >= (includeChrome ? 8 : 4) && uniq.size >= 3) cleaned.push(list);
  }
  if (!cleaned.length) return [];
  cleaned.sort((a, b) => b.length - a.length);
  const top = cleaned[0].length;
  const chosen = cleaned.filter(g => g.length >= Math.max(4, top * 0.4)).slice(0, 3);

  const out = [];
  const seen = new Set();
  chosen.forEach(g => g.forEach(i => {
    const k = i.title.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(i);
  }));
  return out;
}

async function autoDiscoverGenericSources(comp, page) {
  const base = String(comp.base_url || '').trim().replace(/\/+$/, '');
  let origin, baseHost, basePath, baseLocale = '';
  try {
    const bu = new URL(base);
    origin = bu.origin;
    baseHost = bu.hostname.toLowerCase().replace(/^www\./, '');
    basePath = bu.pathname.replace(/\/+$/, '');
    baseLocale = (bu.pathname.split('/').filter(Boolean)[0] || '').toLowerCase();
  } catch (_) { return []; }
  const deadline = Date.now() + GENV4.deadlineMs;
  comp._genReason = null;
  let blockedStreak = 0, blockedStatus = 0;

  const allowedHosts = new Set([baseHost]);
  const hostOk = (host) => {
    const h = String(host || '').toLowerCase().replace(/^www\./, '');
    for (const a of allowedHosts) if (h === a || h.endsWith('.' + a)) return true;
    return false;
  };
  // If the site redirects to another domain, treat that domain as the same site.
  const noteHost = () => {
    try {
      const h = new URL(page.url()).hostname.toLowerCase().replace(/^www\./, '');
      if (h && !allowedHosts.has(h) && !GEN_REDIRECT_DENY.test(h)) {
        allowedHosts.add(h);
        console.log(`   ↪️ ${comp.name}: site redirects to ${h}, treating it as the same site`);
      }
    } catch (_) {}
  };

  const normalize = (href, from, keepQuery = false) => {
    try {
      const u = new URL(href, from || base);
      if (!/^https?:$/.test(u.protocol)) return null;
      if (!hostOk(u.hostname)) return null;
      const first = (u.pathname.split('/').filter(Boolean)[0] || '').toLowerCase();
      if (GEN_LOCALE.test(first) && !GEN_LOCALE.test(baseLocale)) return null;
      if (GEN_SKIP_EXT.test(u.pathname) || GEN_SKIP_PATH.test(u.pathname)) return null;
      if (!keepQuery) u.search = '';
      u.hash = '';
      u.hostname = u.hostname.toLowerCase();
      u.pathname = (u.pathname || '/').replace(/\/{2,}/g, '/');
      if (u.pathname !== '/') u.pathname = u.pathname.replace(/\/+$/, '');
      return u.href;
    } catch (_) { return null; }
  };
  const keyOf = (url) => {
    try { const x = new URL(url); return x.hostname.toLowerCase().replace(/^www\./, '') + x.pathname.replace(/\/+$/, '') + x.search; } catch (_) { return url; }
  };
  const slugTitle = (url) => {
    try { return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); } catch (_) { return ''; }
  };

  // scroll + "Load more" until nothing new appears
  const loadAll = async () => {
    let prev = -1, stale = 0;
    for (let i = 0; i < GENV4.maxLoadMore; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      const clicked = await page.evaluate((sel) => {
        const el = [...document.querySelectorAll('button, [role="button"], a')].find((e) => {
          if (e.closest(sel)) return false;
          const t = (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim();
          if (!/^(load|show|view|see)\s+more(\s+\w+){0,2}$/i.test(t)) return false;
          if (e.tagName === 'A') { const h = e.getAttribute('href') || ''; if (h && !h.startsWith('#') && !/^javascript:/i.test(h)) return false; }
          return e.offsetParent !== null && !e.disabled;
        });
        if (!el) return false;
        try { el.scrollIntoView({ block: 'center' }); el.click(); return true; } catch (_) { return false; }
      }, GEN_CHROME_SEL).catch(() => false);
      await page.waitForTimeout(clicked ? 1500 : 700);
      const count = await page.evaluate(() => document.querySelectorAll('a[href]').length).catch(() => 0);
      if (count === prev) { stale++; if (stale >= 2) break; } else stale = 0;
      prev = count;
    }
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  };

  const items = new Map();
  const sections = [];
  const secSeen = new Set();
  let blogSections = 0;
  let listingsDone = 0;

  const addSection = (url, type, depth, parentNames, label) => {
    if (!url) return false;
    const k = keyOf(url);
    if (secSeen.has(k)) return false;
    if (type === 'Blog') { if (blogSections >= GENV4.maxBlogSections) return false; blogSections++; }
    secSeen.add(k);
    sections.push({ url, type: type || 'Course', depth, parentNames: parentNames || null, label: label || '', done: false });
    return true;
  };

  const processListing = async (sec) => {
    const names = new Map();     // lower -> original (keeps page order)
    const cardUrls = new Map();
    let pageUrl = sec.url, hops = 0, h1 = '', outline = [], diag = null, finalUrl = '';
    const seenPages = new Set();

    while (pageUrl && hops < GENV4.maxPagesPerListing && !seenPages.has(pageUrl) && Date.now() < deadline) {
      seenPages.add(pageUrl);
      hops++;
      let resp;
      try { resp = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: GENV4.pageTimeout }); } catch (_) { break; }
      if (resp && [403, 429].includes(resp.status())) { blockedStreak++; blockedStatus = resp.status(); }
      else if (resp && resp.status() < 400) blockedStreak = 0;
      if (resp && resp.status() >= 400) { diag = { status: resp.status(), links: 0, inMain: 0, title: '' }; break; }
      if (hops === 1) { noteHost(); finalUrl = normalize(page.url(), page.url()) || ''; }
      await page.waitForTimeout(1200);
      await loadAll();
      let r = await page.evaluate(genExtractPage, GEN_CHROME_SEL).catch(() => null);
      if (!r) break;
      let found = genBuildCards(r, pageUrl, normalize);
      if (!found.length && hops === 1) {
        // Nothing found on the first read: the page may still be rendering. Wait, scroll and read again,
        // then retry counting links that were wrongly flagged as menu / footer.
        await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
        await page.waitForTimeout(2500);
        await loadAll();
        const r2 = await page.evaluate(genExtractPage, GEN_CHROME_SEL).catch(() => null);
        if (r2) { r = r2; found = genBuildCards(r, pageUrl, normalize); }
        if (!found.length) found = genBuildCards(r, pageUrl, normalize, true);
      }
      if (hops === 1) {
        diag = { status: resp ? resp.status() : '?', links: (r.links || []).length, inMain: (r.links || []).filter(l => !l.inChrome).length, title: (r.docTitle || '').slice(0, 60) };
        h1 = r.h1 || '';
        outline = r.outline || [];
        if (!h1 || h1.length < 3 || h1.length > 120) h1 = (r.ogTitle || '').slice(0, 120);
      }
      found.forEach(c => {
        const k = c.title.toLowerCase();
        if (!names.has(k)) names.set(k, c.title);
        if (!cardUrls.has(c.url)) cardUrls.set(c.url, c.title);
      });
      let nextUrl = null;
      for (const nx of (r.next || [])) {
        const nn = normalize(nx, pageUrl, true);
        if (nn && !seenPages.has(nn) && keyOf(nn) !== keyOf(pageUrl)) { nextUrl = nn; break; }
      }
      pageUrl = nextUrl;
    }

    let list = [...names.values()];
    // single course page without cards: use its curriculum / module names
    if (list.length < GENV4.minNames && sec.depth === 0 && outline.length >= GENV4.minNames) list = outline;
    list = list.slice(0, GENV4.maxNames);
    if (list.length < GENV4.minNames) {
      if (sec.depth === 0) console.log(`   ⚠️ ${comp.name}: no listing on ${sec.url} (HTTP ${diag ? diag.status : 'n/a'}, ${diag ? diag.links : 0} links, ${diag ? diag.inMain : 0} outside nav, title "${diag ? diag.title : ''}")`);
      return 0;
    }

    if (sec.depth === 1 && sec.parentNames) {
      const overlap = list.filter(n => sec.parentNames.has(n.toLowerCase())).length;
      if (list.length < 8 || overlap / list.length > 0.7) return 0;   // looks like a related-items block, not a listing
    }

    const title = (h1 && !GEN_VAGUE.test(h1) ? h1 : '') || sec.label || slugTitle(sec.url);
    const itemUrl = finalUrl || sec.url;
    const k = keyOf(itemUrl);
    if (!items.has(k)) items.set(k, { url: itemUrl, title: String(title).slice(0, 160), category: sec.type, description: genNamesBlock(list) });
    console.log(`   📋 ${comp.name}: ${sec.type} listing "${String(title).slice(0, 60)}" -> ${list.length} names`);

    // few cards = probably category tiles, so open them too (one level only)
    if (sec.depth === 0 && sec.type !== 'Blog' && list.length <= GENV4.probeIfCardsAtMost) {
      const parentNames = new Set(list.map(n => n.toLowerCase()));
      for (const [cu, ct] of cardUrls) addSection(cu, sec.type, 1, parentNames, ct);
    }
    return list.length;
  };

  const rank = (s) => (s.type === 'Blog' ? 3 : s.depth === 1 ? 2 : 1);
  const runQueue = async () => {
    while (listingsDone < GENV4.maxListings && Date.now() < deadline) {
      if (blockedStreak >= 3 && items.size === 0) break;   // site refuses automated access: stop wasting time
      let idx = -1;
      sections.forEach((s, i) => { if (!s.done && (idx < 0 || rank(s) < rank(sections[idx]))) idx = i; });
      if (idx < 0) break;
      const s = sections[idx];
      s.done = true;
      listingsDone++;
      try { await processListing(s); } catch (_) {}
      if (listingsDone % 5 === 0) console.log(`   📂 ${comp.name}: ${listingsDone} listing pages opened, ${items.size} saved`);
    }
  };

  console.log(`🌐 ${comp.name}: generic discovery v4 started...`);

  // 1) The URL the user typed is itself a listing page (e.g. https://site.com/library)
  let focused = false;
  if (basePath) {
    addSection(normalize(base), genTypeOf(basePath) || 'Course', 0, null, '');
    await runQueue();
    focused = items.size > 0;
  }

  // 2) Otherwise read the homepage navigation and find the Course / Training / Blog sections
  if (!focused) {
    try {
      await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: GENV4.pageTimeout });
      noteHost();
      await page.waitForTimeout(2000);
      const home = await page.evaluate(genExtractPage, GEN_CHROME_SEL).catch(() => null);
      if (home) {
        const found = [];
        for (const l of home.links) {
          const nu = normalize(l.href, origin + '/');
          if (!nu) continue;
          const u = new URL(nu);
          const segs = u.pathname.split('/').filter(Boolean);
          if (!segs.length || segs.length > 2) continue;
          if (segs.length === 2 && !l.inChrome) continue;
          if (segs.some(s => s.includes(':'))) continue;
          const label = String(l.text || '').trim();
          const type = genTypeOf(u.pathname) || (label.length <= 30 ? genTypeOf(label) : null);
          if (type) found.push({ url: nu, type, label: label.length <= 60 ? label : '' });
        }
        const order = { Course: 0, Training: 1, Blog: 2 };
        found.sort((a, b) => order[a.type] - order[b.type]);
        found.forEach(f => { if (sections.length < 14) addSection(f.url, f.type, 0, null, f.label); });
      }
    } catch (_) {}
    console.log(`🧭 ${comp.name}: ${sections.length} section pages found from homepage`);
    await runQueue();
  }

  // 3) Nothing found: try common section paths
  if (items.size === 0 && blockedStreak < 3) {
    console.log(`🧭 ${comp.name}: trying common section paths...`);
    ['/courses', '/library', '/training', '/trainings', '/classes', '/catalog', '/learning-paths', '/programs', '/tutorials', '/blog', '/blogs', '/articles', '/resources/blog']
      .forEach(p => addSection(normalize(origin + p), genTypeOf(p) || 'Course', 0, null, ''));
    await runQueue();
  }

  // 4) Still nothing: read sitemap.xml and derive section pages (e.g. many /courses/<name> urls => /courses is a section)
  if (items.size === 0 && blockedStreak < 3) {
    console.log(`🗺️ ${comp.name}: trying sitemap to find section pages...`);
    try {
      const fetchText = async (u) => {
        try {
          const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
          return r.ok ? await r.text() : null;
        } catch (_) { return null; }
      };
      const locs = (xml) => [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map(m => m[1].trim().replace(/&amp;/g, '&'));
      const queue = [origin + '/sitemap.xml', base + '/sitemap.xml'];
      const seenMaps = new Set();
      const all = [];
      while (queue.length && seenMaps.size < 6 && all.length < 3000) {
        const sm = queue.shift();
        if (seenMaps.has(sm)) continue;
        seenMaps.add(sm);
        const xml = await fetchText(sm);
        if (!xml) continue;
        const l = locs(xml);
        if (/<sitemapindex/i.test(xml)) {
          l.sort((a, b) => (/course|training|blog|learn|post/i.test(b) ? 1 : 0) - (/course|training|blog|learn|post/i.test(a) ? 1 : 0))
            .slice(0, 5).forEach(x => queue.push(x));
        } else all.push(...l);
      }
      const prefixCount = new Map();
      for (const loc of all) {
        const nu = normalize(loc);
        if (!nu) continue;
        const segs = new URL(nu).pathname.split('/').filter(Boolean);
        if (segs.length < 2) continue;
        const t = genTypeOf('/' + segs[0]);
        if (!t) continue;
        prefixCount.set(segs[0], (prefixCount.get(segs[0]) || 0) + 1);
      }
      [...prefixCount.entries()].filter(([, c]) => c >= 5).sort((a, b) => b[1] - a[1]).slice(0, 4)
        .forEach(([seg]) => addSection(normalize(origin + '/' + seg), genTypeOf('/' + seg) || 'Course', 0, null, ''));
      await runQueue();
    } catch (_) {}
  }

  if (items.size === 0) {
    comp._genReason = blockedStreak >= 3
      ? `Site blocks automated access (HTTP ${blockedStatus}). It cannot be scanned automatically.`
      : 'No course, training or blog listing pages found on this site.';
  }

  const list = [...items.values()].filter(i => i.title && i.title.length >= 3);
  console.log(`📚 ${comp.name}: saved ${list.length} listing pages (${listingsDone} pages opened)`);
  return list;
}

async function scrapeGeneric(comp, scanLogId = null) {
  console.log(`🚀 Starting ${comp.name} Scraper (generic engine v4)...`);
  let browser, syncStatus = 'FAILED', totalCoursesFound = 0, isFirstScan = false, failReason = null;
  let detectedChanges = { newCourses: [], modifiedCourses: [] };

  try {
    browser = await chromium.launch(BROWSER_CONFIG);
    const context = await browser.newContext(VIEWPORT_CONFIG);
    const page = await context.newPage();
    const sources = comp.config?.sources || (comp.config?.baseUrl ? [comp.config] : []);

    const allItems = new Map();

    if (!sources.length) {
      const discovered = await autoDiscoverGenericSources(comp, page);
      for (const item of discovered) {
        allItems.set(item.url, {
          title: item.title,
          course_url: item.url,
          category: item.category,
          description: item.description || null
        });
      }
    } else {
      for (const source of sources) {
        await scrapeGenericSource(page, source, allItems);
      }
    }

    if (browser) { await browser.close(); browser = null; }

    totalCoursesFound = allItems.size;

    // Protect existing data when a site returns no usable content.
    if (totalCoursesFound === 0) {
      throw new Error(comp._genReason || 'No course, training or blog listing pages found on this site.');
    }

    console.log(`✅ ${comp.name} Scrape Complete. Found: ${totalCoursesFound}`);

    const canonicalCourseUrl = (value) => {
      try {
        const u = new URL(String(value || '').trim());
        u.hash = '';
        u.hostname = u.hostname.toLowerCase();
        u.pathname = (u.pathname || '/').replace(/\/{2,}/g, '/');
        if (u.pathname !== '/') u.pathname = u.pathname.replace(/\/+$/, '');
        return u.toString();
      } catch (_) {
        return String(value || '').trim().replace(/#.*$/, '').replace(/\/+$/, '');
      }
    };

    const existingRows = [];
    for (let from = 0; ; from += 1000) {
      const { data: rows, error: existingError } = await supabase
        .from('courses')
        .select('id, description, title, category, course_url')
        .eq('competitor_id', comp.id)
        .range(from, from + 999);

      if (existingError) throw existingError;
      if (!rows || !rows.length) break;

      existingRows.push(...rows);
      if (rows.length < 1000) break;
    }

    // first ever scan of this competitor = baseline (no "new" spam)
    isFirstScan = existingRows.length === 0;

    const existingByUrl = new Map();
    for (const row of existingRows) {
      const key = canonicalCourseUrl(row.course_url);
      if (key && !existingByUrl.has(key)) existingByUrl.set(key, row);
    }

    for (const [url, item] of allItems.entries()) {
      const storedUrl = canonicalCourseUrl(url);
      if (!storedUrl) continue;

      const cleanItem = {
        ...item,
        course_url: storedUrl,
        title: String(item.title || '').trim(),
        category: String(item.category || 'Course').trim(),
        description: item.description || null
      };

      const existing = existingByUrl.get(storedUrl);

      if (!existing) {
        const { error: insertError } = await supabase
          .from('courses')
          .insert({ ...cleanItem, competitor_id: comp.id });
        if (insertError) throw insertError;
        detectedChanges.newCourses.push(cleanItem);
      } else {
        const updateData = {
          title: cleanItem.title || existing.title,
          category: cleanItem.category || existing.category,
          course_url: storedUrl,
          last_seen_at: new Date().toISOString()
        };

        const old = genSplitDescription(existing.description);
        const diff = genDiff(old.block, cleanItem.description);

        if (diff.added.length || diff.removed.length) {
          const note = genNote(diff);
          const stamp = new Date().toISOString().slice(0, 10);
          updateData.description = cleanItem.description + GEN_HISTORY_MARK +
            [`• ${stamp}: ${note}`, ...old.history].slice(0, 10).join('\n');
          updateData.last_modified_at = new Date().toISOString();
          detectedChanges.modifiedCourses.push({ ...cleanItem, change_note: note });
        } else if (cleanItem.description && !existing.description) {
          updateData.description = cleanItem.description; // first capture, not a change
        }

        const { error: updateError } = await supabase
          .from('courses')
          .update(updateData)
          .eq('id', existing.id);
        if (updateError) throw updateError;
      }
    }

    syncStatus = 'SUCCESS';
  } catch (error) {
    console.error(`❌ ${comp.name} Scraping failed:`, error);
    failReason = String((error && error.message) || 'Scan failed').slice(0, 300);
  } finally {
    if (browser) await browser.close();
    await supabase.from('competitors').update({ last_scan_at: new Date().toISOString() }).eq('id', comp.id);

    const logPayload = {
      status: syncStatus,
      courses_found: totalCoursesFound,
      new_courses_added: isFirstScan ? 0 : detectedChanges.newCourses.length,
      error_message: syncStatus === 'FAILED' ? (failReason || 'Scan failed') : null
    };
    const brief = (c) => ({ title: c.title, category: c.category, url: c.course_url, note: c.change_note || null });
    const changeDetails = {
      new: isFirstScan ? [] : detectedChanges.newCourses.slice(0, 500).map(brief),
      modified: detectedChanges.modifiedCourses.slice(0, 500).map(brief),
      baseline: isFirstScan
    };
    const writeLog = (extra) => scanLogId
      ? supabase.from('sync_logs').update({ ...logPayload, ...extra }).eq('id', scanLogId)
      : supabase.from('sync_logs').insert({ competitor_id: comp.id, ...logPayload, ...extra });

    const { error: logErr } = await writeLog({ change_details: changeDetails });
    if (logErr) await writeLog({}); // change_details column does not exist -> still log the basics

    return {
      status: syncStatus, totalCoursesFound, firstScan: isFirstScan, error: failReason,
      newCourses: isFirstScan ? [] : detectedChanges.newCourses,
      modifiedCourses: detectedChanges.modifiedCourses
    };
  }
}

// --- API ROUTES & SCHEDULING ---

async function runMasterScanPipeline() {
  console.log('⚙️ Initializing Master Scan Pipeline...');

  const psResult = await guardedScan('Pluralsight', scrapePluralsight);
  const ltResult = await guardedScan('Learning Tree', scrapeLearningTree);
  const dcResult = await guardedScan('Datacouch', scrapeDatacouch);
  const stResult = await guardedScan('Sonatype', scrapeSonatype);
  const trResult = await guardedScan('Trainocate', scrapeTrainocate);
  const gaResult = await guardedScan('General Assembly', scrapeGeneralAssembly);
  const ctResult = await guardedScan('CloudThat', scrapeCloudThat);
  const ncResult = await guardedScan('NetCom Learning', scrapeNetcomLearning);

  const combinedResults = [
    { competitor: 'Pluralsight', data: psResult },
    { competitor: 'Learning Tree', data: ltResult },
    { competitor: 'Datacouch', data: dcResult },
    { competitor: 'Sonatype', data: stResult },
    { competitor: 'Trainocate', data: trResult },
    { competitor: 'General Assembly', data: gaResult },
    { competitor: 'CloudThat', data: ctResult },
    { competitor: 'NetCom Learning', data: ncResult }
  ];

  const { data: genericCompetitors } = await supabase
    .from('competitors')
    .select('*')
    .eq('auto_detected', true)
    .eq('status', 'active');

  for (const comp of (genericCompetitors || [])) {
    const claim = await claimScan(comp);
    const result = claim.ok
      ? await (async () => { try { return await scrapeGeneric(comp); } finally { await releaseScan(claim); } })()
      : { status: 'SKIPPED', totalCoursesFound: 0, newCourses: [], modifiedCourses: [] };
    combinedResults.push({ competitor: comp.name, data: result });
  }

  await sendCombinedAlertEmail(combinedResults).catch(console.error);
  return combinedResults;
}

// ==========================================
// 10. DAILY PER-CATEGORY GOOGLE CHAT ALERTS
// ==========================================
// Separate from the weekly combined email above. Each weekday, only the
// category(ies) assigned to that day (categories.schedule_day, ISO weekday:
// 1=Mon..5=Fri) are scanned, and a summary is posted to Google Chat.

const HARDCODED_SCRAPERS = {
  'Pluralsight': scrapePluralsight,
  'Learning Tree': scrapeLearningTree,
  'Datacouch': scrapeDatacouch,
  'Sonatype': scrapeSonatype,
  'Trainocate': scrapeTrainocate,
  'General Assembly': scrapeGeneralAssembly,
  'CloudThat': scrapeCloudThat,
  'NetCom Learning': scrapeNetcomLearning
};

async function postToGoogleChat(text, attempt = 1) {
  if (process.env.RADAR_DRY_RUN) { console.log('💬 [DRY RUN] would post to Google Chat:\n' + text + '\n'); return; }
  const webhookUrl = process.env.GCHAT_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log('ℹ️ GCHAT_WEBHOOK_URL not set — skipping Google Chat post.');
    return;
  }
  const MAX_ATTEMPTS = 4;
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ text })
    });
    if (res.status === 429 && attempt < MAX_ATTEMPTS) {
      const backoffMs = 2000 * attempt;
      console.log(`⚠️ Google Chat rate-limited (429), retrying in ${backoffMs}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})...`);
      await new Promise(r => setTimeout(r, backoffMs));
      return postToGoogleChat(text, attempt + 1);
    }
    if (!res.ok) {
      console.error(`❌ Google Chat post failed: ${res.status} ${await res.text()}`);
    } else {
      console.log('✅ Posted to Google Chat.');
    }
  } catch (error) {
    console.error('❌ Google Chat post failed:', error);
  }
  // Small pacing delay so a burst of chunked messages (large new/modified
  // lists) doesn't immediately trip Google Chat's rate limit again.
  await new Promise(r => setTimeout(r, 1200));
}

// Google Chat webhook messages are capped at 4096 characters. Every new/
// modified item must still show up somewhere, so instead of truncating with
// an "...and N more" dead-end, a competitor's full list is split across as
// many messages as it takes.
const GCHAT_MAX_MESSAGE_CHARS = 3800; // headroom under the real 4096 limit

function buildCompetitorChatMessages(categoryName, competitor, data) {
  const newC = data.newCourses || [];
  const modC = data.modifiedCourses || [];
  if (data.status === 'PAUSED' || (newC.length === 0 && modC.length === 0)) return [];

  const lines = [`🚨 *Competitor Radar — ${categoryName}*`, `*${competitor}*`];
  if (newC.length > 0) {
    lines.push(`🌟 New (${newC.length}):`);
    newC.forEach(c => lines.push(`• <${c.course_url}|${c.title}>`));
  }
  if (modC.length > 0) {
    lines.push(`📝 Modified (${modC.length}):`);
    modC.forEach(c => lines.push(`• <${c.course_url}|${c.title}>` + (c.change_note ? `\n   ${c.change_note}` : '')));
  }

  // Pack lines into messages under the char limit; re-send the header on
  // every part after the first so each message stands on its own.
  const header = lines[0];
  const body = lines.slice(1);
  const messages = [];
  let current = header;
  let partHeaderNeeded = false;

  for (const line of body) {
    const candidate = current + '\n' + line;
    if (candidate.length > GCHAT_MAX_MESSAGE_CHARS && current !== header) {
      messages.push(current);
      current = partHeaderNeeded ? `${header} (cont.)\n${line}` : `${header}\n${line}`;
      partHeaderNeeded = true;
    } else {
      current = candidate;
    }
  }
  messages.push(current);

  if (messages.length > 1) {
    return messages.map((m, i) => `${m}\n\n(part ${i + 1}/${messages.length})`);
  }
  return messages;
}

const WEEKDAY_NAME_TO_ISO = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7 };

// Resolves the ISO weekday (1=Mon..7=Sun) this run is FOR. Prefers an
// explicit override - set by the workflow from which cron fired, e.g.
// '3', or a day name like 'wednesday' from a manual dispatch - over the
// runner's actual wall-clock day, since GitHub Actions can delay a
// scheduled run by hours and the wall clock may have rolled past midnight
// UTC by the time the script executes.
function resolveIsoDay(override) {
  if (override && override !== 'auto') {
    const numeric = parseInt(override, 10);
    if (!isNaN(numeric) && numeric >= 1 && numeric <= 7) return numeric;
    const named = WEEKDAY_NAME_TO_ISO[String(override).toLowerCase()];
    if (named) return named;
    console.log(`⚠️ Unrecognized RADAR_DAY override "${override}" — falling back to actual current day.`);
  }
  const jsDay = new Date().getDay(); // 0=Sun..6=Sat
  return jsDay === 0 ? 7 : jsDay; // 1=Mon..7=Sun
}

// ---- duplicate-run guard: only for SCHEDULED GitHub runs (manual runs and the dashboard always scan) ----
const DUPLICATE_GUARD_HOURS = 3;

async function claimScan(comp) {
  if (process.env.GITHUB_EVENT_NAME !== 'schedule') return { ok: true, id: null };
  try {
    const since = new Date(Date.now() - DUPLICATE_GUARD_HOURS * 3600 * 1000).toISOString();
    const done = await supabase.from('sync_logs').select('id').eq('competitor_id', comp.id).eq('status', 'SUCCESS').gt('courses_found', 0).gte('created_at', since).limit(1);
    if (done.data && done.data.length) return { ok: false, why: `already scanned in the last ${DUPLICATE_GUARD_HOURS} hours` };

    const mine = await supabase.from('sync_logs')
      .insert({ competitor_id: comp.id, status: 'RUNNING', courses_found: 0, new_courses_added: 0 })
      .select('id, created_at').single();
    if (mine.error || !mine.data) return { ok: true, id: null };      // cannot lock: scan anyway

    // if two runs started together, the OLDEST marker wins, the other one steps aside
    const running = await supabase.from('sync_logs').select('id, created_at')
      .eq('competitor_id', comp.id).eq('status', 'RUNNING').gte('created_at', since)
      .order('created_at', { ascending: true }).order('id', { ascending: true });
    const first = running.data && running.data[0];
    if (first && first.id !== mine.data.id) {
      await supabase.from('sync_logs').delete().eq('id', mine.data.id);
      return { ok: false, why: 'another run is scanning it right now' };
    }
    // the other run may have finished between my first check and my marker: look once more
    const again = await supabase.from('sync_logs').select('id').eq('competitor_id', comp.id).eq('status', 'SUCCESS').gt('courses_found', 0).gte('created_at', since).limit(1);
    if (again.data && again.data.length) {
      await supabase.from('sync_logs').delete().eq('id', mine.data.id);
      return { ok: false, why: `already scanned in the last ${DUPLICATE_GUARD_HOURS} hours` };
    }
    return { ok: true, id: mine.data.id };
  } catch (_) {
    return { ok: true, id: null };
  }
}

async function releaseScan(claim) {
  if (!claim || !claim.id) return;
  try { await supabase.from('sync_logs').delete().eq('id', claim.id); } catch (_) {}
}

// used by the weekly full scan (built-in scrapers look their row up by name)
async function guardedScan(name, scraper) {
  let comp = null;
  try {
    const { data } = await supabase.from('competitors').select('id, name').eq('name', name).limit(1);
    comp = data && data[0];
  } catch (_) {}
  if (!comp) return await scraper();
  const claim = await claimScan(comp);
  if (!claim.ok) {
    console.log(`⏭️ ${name}: skipped (${claim.why})`);
    return { status: 'SKIPPED', totalCoursesFound: 0, newCourses: [], modifiedCourses: [] };
  }
  try { return await scraper(); } finally { await releaseScan(claim); }
}

// daily scan v3
async function runCategoryScanForToday(dayOverride) {
  const isoDay = resolveIsoDay(dayOverride !== undefined ? dayOverride : process.env.RADAR_DAY);
  const dayName = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][isoDay] || String(isoDay);

  const { data: todaysCategories, error: catErr } = await supabase
    .from('categories')
    .select('id, name')
    .eq('schedule_day', isoDay);

  if (catErr) {
    console.error('❌ Could not read categories:', catErr.message);
    return [];
  }
  if (!todaysCategories || todaysCategories.length === 0) {
    console.log(`ℹ️ No categories scheduled for weekday ${isoDay} (1=Mon..7=Sun). Nothing to do.`);
    return [];
  }

  const allResults = [];
  for (const cat of todaysCategories) {
    // every ACTIVE competitor of the category: built-in ones and the ones added from the dashboard
    const { data: competitors, error: compErr } = await supabase
      .from('competitors')
      .select('*')
      .eq('category_id', cat.id)
      .eq('status', 'active')
      .order('name');
    if (compErr) { console.error(`❌ Could not read competitors of ${cat.name}:`, compErr.message); continue; }

    const list = competitors || [];
    console.log(`📅 ${dayName}: category "${cat.name}" -> ${list.length} competitor(s): ${list.map(c => c.name).join(', ') || '-'}`);
    if (!list.length) continue;

    const results = [];
    let newTotal = 0, modTotal = 0, baselines = 0, postedAny = false;
    const failed = [], skipped = [], builtIn = [], added = [];

    for (const comp of list) {
      const bucket = comp.auto_detected ? added : builtIn;

      const claim = await claimScan(comp);
      if (!claim.ok) {
        skipped.push(comp.name);
        bucket.push(`${comp.name} ⏭️`);
        console.log(`⏭️ ${comp.name}: skipped (${claim.why})`);
        continue;
      }

      let result;
      try {
        const hardcoded = HARDCODED_SCRAPERS[comp.name];
        if (hardcoded) {
          result = (typeof runBuiltInWithNotes === 'function')
            ? await runBuiltInWithNotes(comp, hardcoded)
            : await hardcoded();
        } else {
          result = await scrapeGeneric(comp);
        }
      } catch (e) {
        console.error(`❌ ${comp.name} crashed:`, e);
        result = { status: 'FAILED', error: String((e && e.message) || e).slice(0, 200), newCourses: [], modifiedCourses: [] };
      } finally {
        await releaseScan(claim);
      }
      results.push({ competitor: comp.name, data: result });

      if (result.status === 'FAILED') {
        failed.push({ name: comp.name, reason: result.error || 'see server log' });
        bucket.push(`${comp.name} ⚠️`);
        continue;
      }

      if (result.firstScan) {
        baselines++;
        postedAny = true;
        bucket.push(`${comp.name} 🆕`);
        await postToGoogleChat(`🚨 *Competitor Radar — ${cat.name}*\n*${comp.name}*: first scan complete, ${result.totalCoursesFound} pages saved as baseline. Changes will be reported from the next scan.`);
        continue;
      }

      bucket.push(`${comp.name} ✅`);
      newTotal += (result.newCourses || []).length;
      modTotal += (result.modifiedCourses || []).length;
      for (const message of buildCompetitorChatMessages(cat.name, comp.name, result)) {
        postedAny = true;
        await postToGoogleChat(message);
      }
    }

    // a second run that found everything already scanned stays silent (no duplicate Chat summary)
    if (skipped.length === list.length) {
      console.log(`⏭️ ${cat.name}: everything was already scanned, no Chat summary sent.`);
      continue;
    }

    const scannedCount = list.length - skipped.length;
    const lines = [
      `📊 *Competitor Radar — ${cat.name}* (${dayName} scan)`,
      `Scanned ${scannedCount} of ${list.length} competitor${list.length === 1 ? '' : 's'}: 🌟 ${newTotal} new, 📝 ${modTotal} updated` +
        (baselines ? `, 🆕 ${baselines} first scan${baselines === 1 ? '' : 's'}` : '') +
        (failed.length ? `, ⚠️ ${failed.length} failed` : '') +
        (skipped.length ? `, ⏭️ ${skipped.length} already scanned` : '')
    ];
    if (builtIn.length) lines.push(`Built-in: ${builtIn.join(', ')}`);
    if (added.length) lines.push(`Added from dashboard: ${added.join(', ')}`);
    lines.push('✅ scanned   🆕 first scan   ⚠️ failed   ⏭️ already scanned');
    if (!postedAny && !failed.length) lines.push('No new or modified content today.');
    failed.forEach(f => lines.push(`⚠️ ${f.name}: scan failed — ${f.reason}`));
    await postToGoogleChat(lines.join('\n'));

    allResults.push({ category: cat.name, results });
  }

  return allResults;
}

app.post('/api/scrape/all', async (req, res) => {
  try {
    const results = await runCategoryScanForToday();
    res.json({ status: 'SUCCESS', results });
  } catch (error) {
    console.error('❌ Daily Master Scan error:', error);
    res.status(500).json({
      status: 'ERROR',
      error: error.message
    });
  }
});

app.post('/api/scrape/:competitor', async (req, res) => {
  const competitor = req.params.competitor.toLowerCase();
  let result;
  let compName = '';
  let liveRunningLogId = null;

  // Create a temporary RUNNING row for hardcoded scrapers.
  // Generic scraper already creates its own RUNNING log.
  const hardcodedCompetitors = [
    'pluralsight',
    'learningtree',
    'datacouch',
    'sonatype',
    'trainocate',
    'generalassembly',
    'cloudthat',
    'netcomlearning'
  ];

  if (hardcodedCompetitors.includes(competitor)) {
    const { data: liveLog, error: liveLogError } = await supabase
      .from('sync_logs')
      .insert({
        competitor_id: (
          await supabase
            .from('competitors')
            .select('id')
            .eq('name', {
              pluralsight: 'Pluralsight',
              learningtree: 'Learning Tree',
              datacouch: 'Datacouch',
              sonatype: 'Sonatype',
              trainocate: 'Trainocate',
              generalassembly: 'General Assembly',
              cloudthat: 'CloudThat',
              netcomlearning: 'NetCom Learning'
            }[competitor])
            .single()
        ).data?.id,
        status: 'RUNNING',
        courses_found: 0,
        new_courses_added: 0
      })
      .select('id')
      .single();

    if (!liveLogError && liveLog) {
      liveRunningLogId = liveLog.id;
      console.log(`⏳ ${competitor}: RUNNING status created (${liveRunningLogId})`);
    }
  }
  
  if (competitor === 'pluralsight') { result = await scrapePluralsight(); compName = 'Pluralsight'; }
  else if (competitor === 'learningtree') { result = await scrapeLearningTree(); compName = 'Learning Tree'; }
  else if (competitor === 'datacouch') { result = await scrapeDatacouch(); compName = 'Datacouch'; }
  else if (competitor === 'sonatype') { result = await scrapeSonatype(); compName = 'Sonatype'; }
  else if (competitor === 'trainocate') { result = await scrapeTrainocate(); compName = 'Trainocate'; }
  else if (competitor === 'generalassembly') { result = await scrapeGeneralAssembly(); compName = 'General Assembly'; }
  else if (competitor === 'cloudthat') { result = await scrapeCloudThat(); compName = 'CloudThat'; }
  else if (competitor === 'netcomlearning') { result = await scrapeNetcomLearning(); compName = 'NetCom Learning'; }
  else {
    const { data: genericCompetitors } = await supabase.from('competitors').select('*').eq('auto_detected', true);
    const match = (genericCompetitors || []).find(c => c.name.toLowerCase().replace(/[^a-z0-9]/g, '') === competitor);
    if (!match) return res.status(400).json({ error: 'Unknown competitor' });
    const { data: runningLog, error: runningLogError } = await supabase
      .from('sync_logs')
      .insert({
        competitor_id: match.id,
        status: 'RUNNING',
        courses_found: 0,
        new_courses_added: 0
      })
      .select('id')
      .single();

    if (runningLogError) return res.status(500).json({ error: runningLogError.message });

    result = await scrapeGeneric(match, runningLog.id);
    compName = match.name;
  }

  // Remove only the temporary RUNNING row.
  // The scraper's normal SUCCESS/FAILED log remains as the final history row.
  if (liveRunningLogId) {
    await supabase
      .from('sync_logs')
      .delete()
      .eq('id', liveRunningLogId);
  }

  // Individual Email trigger logic is correctly connected here
  // EMAIL DISABLED DURING TESTING
  res.json(result);
});


// ==========================================
// 📊 DASHBOARD / INTELLIGENCE APIs
// ==========================================

app.get('/api/dashboard', async (req, res) => {
  try {
    const [
      competitorsResult,
      categoriesResult,
      coursesCountResult,
      logsCountResult
    ] = await Promise.all([
      supabase
        .from('competitors')
        .select('*')
        .eq('status', 'active'),

      supabase
        .from('categories')
        .select('*'),

      supabase
        .from('courses')
        .select('*', { count: 'estimated', head: true }),

      supabase
        .from('sync_logs')
        .select('*', { count: 'estimated', head: true })
    ]);

    if (competitorsResult.error) throw competitorsResult.error;
    if (categoriesResult.error) throw categoriesResult.error;
    if (coursesCountResult.error) throw coursesCountResult.error;
    if (logsCountResult.error) throw logsCountResult.error;

    const competitors = competitorsResult.data || [];
    const categories = categoriesResult.data || [];

    res.json({
      status: 'SUCCESS',

      stats: {
        competitors: competitors.length,
        trackedContent: coursesCountResult.count || 0,
        scanRuns: logsCountResult.count || 0,
        categories: categories.length
      },

      competitors,
      categories
    });

  } catch (error) {
    console.error('❌ Dashboard API error:', error);

    res.status(500).json({
      status: 'ERROR',
      error: error.message
    });
  }
});


app.get('/api/competitors', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('competitors')
      .select('*')
      .eq('status', 'active')
      .order('name');

    if (error) throw error;

    res.json({
      status: 'SUCCESS',
      competitors: data || []
    });

  } catch (error) {
    console.error('❌ Competitors API error:', error);

    res.status(500).json({
      status: 'ERROR',
      error: error.message
    });
  }
});


app.get('/api/categories', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('categories')
      .select('*')
      .order('schedule_day');

    if (error) throw error;

    res.json({
      status: 'SUCCESS',
      categories: data || []
    });

  } catch (error) {
    console.error('❌ Categories API error:', error);

    res.status(500).json({
      status: 'ERROR',
      error: error.message
    });
  }
});


app.get('/api/courses', async (req, res) => {
  try {
    const { data, error, count } = await supabase
      .from('courses')
      .select('id, title, category, course_url, last_seen_at, last_modified_at, competitor_id, competitors(name)', { count: 'estimated' })
      .order('last_seen_at', { ascending: false })
      .range(0, 2999);

    if (error) throw error;

    res.json({
      status: 'SUCCESS',
      courses: data || [],
      count: count || 0
    });

  } catch (error) {
    console.error('❌ Courses API error:', error);

    res.status(500).json({
      status: 'ERROR',
      error: error.message
    });
  }
});


// Single content item with its inner details (sub-course names + change history)
app.get('/api/courses/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('courses')
      .select('id, title, category, course_url, description, last_modified_at')
      .eq('id', req.params.id)
      .single();
    if (error) throw error;
    res.json({ status: 'SUCCESS', course: data });
  } catch (error) {
    res.status(500).json({ status: 'ERROR', error: error.message });
  }
});

// Content whose sub-course list changed (what was added / removed)
app.get('/api/content-changes', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('courses')
      .select('id, title, category, course_url, description, last_modified_at, competitor_id')
      .not('last_modified_at', 'is', null)
      .order('last_modified_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    const mark = '📝 Change history (latest first):';
    const changes = (data || []).map(r => {
      const d = String(r.description || '');
      const i = d.indexOf(mark);
      const history = i < 0 ? [] : d.slice(i + mark.length).split('\n').map(s => s.trim()).filter(Boolean);
      return {
        id: r.id, title: r.title, category: r.category, course_url: r.course_url,
        competitor_id: r.competitor_id, last_modified_at: r.last_modified_at, history
      };
    });
    res.json({ status: 'SUCCESS', changes });
  } catch (error) {
    console.error('❌ Content changes API error:', error);
    res.status(500).json({ status: 'ERROR', error: error.message });
  }
});

app.get('/api/scan-runs', async (req, res) => {
  try {
    const { data, error, count } = await supabase
      .from('sync_logs')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({
      status: 'SUCCESS',
      scanRuns: data || [],
      count: count || 0
    });

  } catch (error) {
    console.error('❌ Scan Runs API error:', error);

    res.status(500).json({
      status: 'ERROR',
      error: error.message
    });
  }
});


app.get('/api/changes', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sync_logs')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({
      status: 'SUCCESS',
      changes: data || []
    });

  } catch (error) {
    console.error('❌ Changes API error:', error);

    res.status(500).json({
      status: 'ERROR',
      error: error.message
    });
  }
});


app.post('/api/competitors', async (req, res) => {
  try {
    const {
      name,
      base_url,
      category_id
    } = req.body;

    if (!name || !base_url || !category_id) {
      return res.status(400).json({
        status: 'ERROR',
        error: 'Name, website URL and category are required.'
      });
    }

    const cleanName = name.trim();
    const cleanUrl = base_url.trim();

    let normalizedUrl = cleanUrl;
    try {
      const u = new URL(cleanUrl);
      u.hash = '';
      u.pathname = (u.pathname || '/').replace(/\/+$/, '') || '/';
      normalizedUrl = u.toString().toLowerCase();
    } catch (_) {}

    const { data: activeCompetitors, error: duplicateCheckError } = await supabase
      .from('competitors')
      .select('id, name, base_url')
      .eq('status', 'active');

    if (duplicateCheckError) throw duplicateCheckError;

    const duplicate = (activeCompetitors || []).find(c => {
      let existingUrl = String(c.base_url || '').trim();
      try {
        const u = new URL(existingUrl);
        u.hash = '';
        u.pathname = (u.pathname || '/').replace(/\/+$/, '') || '/';
        existingUrl = u.toString().toLowerCase();
      } catch (_) {}
      return existingUrl === normalizedUrl;
    });

    if (duplicate) {
      return res.status(409).json({
        status: 'ERROR',
        error: `Competitor already exists: ${duplicate.name}`
      });
    }

    const { data, error } = await supabase
      .from('competitors')
      .insert({
        name: cleanName,
        base_url: cleanUrl,
        category_id: category_id || null,
        is_active: true,
        status: 'active',
        auto_detected: true
      })
      .select()
      .single();

    if (error) throw error;

    res.json({ status: 'SUCCESS', competitor: data });

    // Auto first scan for THIS new competitor only (runs in background)
    (async () => {
      const { data: log } = await supabase
        .from('sync_logs')
        .insert({ competitor_id: data.id, status: 'RUNNING', courses_found: 0, new_courses_added: 0 })
        .select('id')
        .single();
      await scrapeGeneric(data, log?.id || null);
    })().catch(err => console.error('❌ Auto-scan after add failed:', err));


  } catch (error) {
    console.error('❌ Add Competitor API error:', error);

    res.status(500).json({
      status: 'ERROR',
      error: error.message
    });
  }
});

// Clears ONLY the tracked content of a competitor added from the dashboard (auto_detected), so it can be rescanned cleanly.
app.post('/api/competitors/:id/reset', async (req, res) => {
  try {
    const { data: comp, error: compErr } = await supabase.from('competitors').select('id, name, auto_detected').eq('id', req.params.id).single();
    if (compErr || !comp) return res.status(404).json({ status: 'ERROR', error: 'Competitor not found' });
    if (!comp.auto_detected) return res.status(400).json({ status: 'ERROR', error: 'Reset is only allowed for competitors added from the dashboard.' });
    const { error } = await supabase.from('courses').delete().eq('competitor_id', comp.id);
    if (error) throw error;
    res.json({ status: 'SUCCESS', competitor: comp.name });
  } catch (error) {
    console.error('❌ Reset competitor error:', error);
    res.status(500).json({ status: 'ERROR', error: error.message });
  }
});

// Deletes a dashboard-added competitor AND all of its data (content rows + scan logs).
app.delete('/api/competitors/:id', async (req, res) => {
  try {
    const { data: comp, error: compErr } = await supabase
      .from('competitors').select('id, name, auto_detected').eq('id', req.params.id).single();
    if (compErr || !comp) return res.status(404).json({ status: 'ERROR', error: 'Competitor not found' });
    if (!comp.auto_detected) {
      return res.status(400).json({ status: 'ERROR', error: 'Built-in competitors cannot be deleted.' });
    }
    const delCourses = await supabase.from('courses').delete().eq('competitor_id', comp.id);
    if (delCourses.error) throw delCourses.error;
    const delLogs = await supabase.from('sync_logs').delete().eq('competitor_id', comp.id);
    if (delLogs.error) throw delLogs.error;
    const delComp = await supabase.from('competitors').delete().eq('id', comp.id);
    if (delComp.error) throw delComp.error;
    console.log('🗑️ Deleted competitor and all its data: ' + comp.name);
    res.json({ status: 'SUCCESS', deleted: comp.name });
  } catch (error) {
    console.error('❌ Delete competitor error:', error);
    res.status(500).json({ status: 'ERROR', error: error.message });
  }
});

// Exact items that changed today (same links that Google Chat sends).
app.get('/api/todays-changes', async (req, res) => {
  try {
    const p = req.query.since ? new Date(String(req.query.since)) : null;
    const since = (p && !isNaN(p.getTime())) ? p : (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();
    const sinceIso = since.toISOString();
    const mark = '📝 Change history (latest first):';

    // 1) content whose list changed / was updated today
    const modRes = await supabase.from('courses')
      .select('id, title, category, course_url, description, last_modified_at, competitor_id')
      .gte('last_modified_at', sinceIso)
      .order('last_modified_at', { ascending: false })
      .limit(300);
    if (modRes.error) throw modRes.error;
    const modified = (modRes.data || []).map(r => {
      const d = String(r.description || '');
      const i = d.indexOf(mark);
      const history = i < 0 ? [] : d.slice(i + mark.length).split('\n').map(x => x.trim()).filter(Boolean);
      const note = history[0] ? history[0].replace(/^•\s+(\d{4}-\d{2}-\d{2}:\s*)?/, '') : '';
      return { id: r.id, title: r.title, category: r.category, url: r.course_url, competitor_id: r.competitor_id, note };
    });

    // 2) content added today (skipped for a competitor whose very first scan happened today = baseline)
    let created = [];
    const newRes = await supabase.from('courses')
      .select('id, title, category, course_url, competitor_id, created_at')
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(1000);
    if (!newRes.error) {
      const byComp = new Map();
      for (const r of (newRes.data || [])) {
        if (!byComp.has(r.competitor_id)) byComp.set(r.competitor_id, []);
        byComp.get(r.competitor_id).push(r);
      }
      for (const [cid, rows] of byComp) {
        const { data: first } = await supabase.from('courses').select('created_at').eq('competitor_id', cid).order('created_at', { ascending: true }).limit(1);
        const firstAt = first && first[0] ? new Date(first[0].created_at) : null;
        if (firstAt && firstAt >= since) continue;
        created.push(...rows);
      }
    } else {
      // no created_at column: fall back to the scan logs if they carry change details
      const logRes = await supabase.from('sync_logs').select('competitor_id, change_details').gte('created_at', sinceIso);
      if (!logRes.error) {
        for (const l of (logRes.data || [])) {
          ((l.change_details && l.change_details.new) || []).forEach(i => created.push({ id: i.url, title: i.title, category: i.category, course_url: i.url, competitor_id: l.competitor_id }));
        }
      }
    }
    const added = created.map(r => ({ id: r.id, title: r.title, category: r.category, url: r.course_url, competitor_id: r.competitor_id }));
    res.json({ status: 'SUCCESS', new: added, modified });
  } catch (error) {
    console.error('❌ Today changes API error:', error);
    res.status(500).json({ status: 'ERROR', error: error.message });
  }
});

module.exports = { scrapeGeneric, runMasterScanPipeline, sendCombinedAlertEmail, runCategoryScanForToday, postToGoogleChat, buildCompetitorChatMessages, HARDCODED_SCRAPERS, resolveIsoDay };

// ==========================================
// 🚀 SERVER STARTUP
// ==========================================
// Start the API server only.
// Scraping runs when triggered from the dashboard/API.
if (require.main === module) {
  // Scheduled run (GitHub Actions): RADAR_MODE decides what to run, then exit.
  if (process.env.RADAR_MODE) {
    (async () => {
      try {
        if (process.env.RADAR_MODE === 'weekly-email') await runMasterScanPipeline();
        else await runCategoryScanForToday();
      } catch (e) { console.error('❌ Scheduled run failed:', e); process.exitCode = 1; }
      process.exit();
    })();
    return;
  }
  const PORT = process.env.PORT || 3000;

  app.listen(PORT, () => {
    console.log(`🚀 Competitor Radar server running on http://localhost:${PORT}`);
    console.log(`✅ Server started WITHOUT automatic scraping.`);
    supabase.from('sync_logs').update({ status: 'FAILED' }).eq('status', 'RUNNING').then(() => {});
    console.log(`👉 Run Master Scan from the dashboard when you want to scrape.`);
  });
}
