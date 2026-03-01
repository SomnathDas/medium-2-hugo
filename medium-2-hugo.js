#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const cheerio = require('cheerio');
const TurndownService = require('turndown');
const axios = require('axios');
const slugify = require('slugify');
const { program } = require('commander');
const ora = require('ora');
const chalk = require('chalk');

// CLI Setup
program
  .name('medium-2-hugo')
  .description('Convert Medium exported HTML posts into Hugo Page Bundles.')
  .requiredOption('-i, --input <path>', 'Path to the folder containing Medium HTML files. Use -h or --help for help.')
  .option('-o, --output <path>', 'Path to generate the Hugo content', './hugo_content')
  .option('-s, --skip-images', 'Skip downloading images (useful if already downloaded)')
  .parse(process.argv);

const options = program.opts();
const INPUT_DIR = path.resolve(options.input);
const OUTPUT_DIR = path.resolve(options.output);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const failedImages = [];

const turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced'
});

turndownService.addRule('mediumCodeBlocks', {
    filter: 'pre',
    replacement: function (content, node) {
        function extractCode(n) {
            let text = '';
            for (let i = 0; i < n.childNodes.length; i++) {
                const child = n.childNodes[i];
                if (child.nodeName === 'BR') {
                    text += '\n';
                } else if (child.nodeName === 'DIV' || child.nodeName === 'P') {
                    text += '\n' + extractCode(child) + '\n';
                } else if (child.nodeType === 3) { 
                    text += child.nodeValue;
                } else {
                    text += extractCode(child);
                }
            }
            return text;
        }

        const rawCode = extractCode(node).trim();
        return '\n```\n' + rawCode + '\n```\n\n';
    }
});

turndownService.addRule('mediumInlineCode', {
    filter: function (node) {
        return node.nodeName === 'CODE' && node.parentNode.nodeName !== 'PRE';
    },
    replacement: function (content, node) {
        return '`' + node.textContent + '`';
    }
});

const asciiArt = `
┌┬┐┌─┐┌┬┐┬┬ ┬┌┬┐   ╦╦   ┬ ┬┬ ┬┌─┐┌─┐
│││├┤  ││││ ││││───║║───├─┤│ ││ ┬│ │
┴ ┴└─┘─┴┘┴└─┘┴ ┴   ╩╩   ┴ ┴└─┘└─┘└─┘
`;

async function downloadImage(url, filepath, spinner, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await axios({
                url,
                method: 'GET',
                responseType: 'arraybuffer',
                timeout: 15000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
                }
            });
            await fs.writeFile(filepath, response.data);
            return true;
            
        } catch (error) {
            if (error.response && error.response.status === 429) {
                const waitTime = Math.pow(2, attempt) * 1000; 
                spinner.text = chalk.yellow(`Medium is rate-limiting us. Pausing for ${waitTime / 1000} seconds (retry ${attempt} of ${retries})...`);
                await sleep(waitTime);
            } else if (attempt < retries) {
                spinner.text = chalk.yellow(`Download failed. Trying again (retry ${attempt} of ${retries})...`);
                await sleep(2000);
            }
        }
    }
    return false;
}

async function processPost(filePath, currentStep, totalSteps) {
    const html = await fs.readFile(filePath, 'utf-8');
    const $ = cheerio.load(html);

    const title = $('.p-name').first().text() || $('title').text() || 'Untitled Post';
    const dateStr = $('.dt-published').attr('datetime');
    const date = dateStr ? new Date(dateStr).toISOString() : new Date().toISOString();
    
    const slug = slugify(title, { lower: true, strict: true, remove: /[*+~.()'"!:@]/g });
    if (!slug) return; 

    const spinner = ora(`[${currentStep}/${totalSteps}] Processing: ${title}`).start();

    const postDir = path.join(OUTPUT_DIR, slug);
    await fs.mkdir(postDir, { recursive: true });

    const contentArea = $('.e-content');
    contentArea.find('.p-name').remove();

    const images = contentArea.find('img');
    for (let i = 0; i < images.length; i++) {
        const img = $(images[i]);
        let src = img.attr('src');
        
        if (src) {
            let cleanUrl = src.split('?')[0];
            
            if (cleanUrl.includes('medium.com')) {
                const urlParts = cleanUrl.split('/');
                const imageId = urlParts.pop(); 
                cleanUrl = `https://miro.medium.com/max/3840/${imageId}`;
            }

            let ext = path.extname(cleanUrl) || '.jpg'; 
            const imageName = `image-${i + 1}${ext}`;
            const imagePath = path.join(postDir, imageName);

            if (!options.skipImages) {
                spinner.text = `[${currentStep}/${totalSteps}] ${title} - Downloading image ${i + 1} of ${images.length}...`;
                
                if (i > 0) await sleep(1500);
                
                const success = await downloadImage(cleanUrl, imagePath, spinner); 
                
                if (!success) {
                    failedImages.push({
                        article: title,
                        imageName: imageName,
                        url: cleanUrl
                    });
                }
            }

            const figCaptionEl = img.closest('figure').find('figcaption');
            const figCaptionText = figCaptionEl.text();
            figCaptionEl.remove();

            const altText = img.attr('alt') || figCaptionText || `Image ${i + 1}`;
            img.attr('src', imageName);
            img.attr('alt', altText);
        }
    }

    const markdownContent = turndownService.turndown(contentArea.html() || '');

    const frontMatter = `---
title: "${title.replace(/"/g, '\\"')}"
date: ${date}
draft: false
slug: "${slug}"
---

`;

    const mdFilePath = path.join(postDir, 'index.md');
    await fs.writeFile(mdFilePath, frontMatter + markdownContent);
    spinner.succeed(`[${currentStep}/${totalSteps}] Finished: ${title}`);
}

async function main() {
    console.log(chalk.cyan(asciiArt));

    try {
        try {
            await fs.access(INPUT_DIR);
        } catch {
            console.error(chalk.red(`I couldn't find the input directory at "${INPUT_DIR}". Please check the path and try again.`));
            process.exit(1);
        }

        await fs.mkdir(OUTPUT_DIR, { recursive: true });

        const files = await fs.readdir(INPUT_DIR);
        const htmlFiles = files.filter(f => f.endsWith('.html'));

        if (htmlFiles.length === 0) {
            console.log(chalk.yellow(`I didn't find any HTML files in ${INPUT_DIR}.`));
            return;
        }

        console.log(chalk.bold(`Found ${htmlFiles.length} posts. Starting the conversion process...\n`));
        if (options.skipImages) {
            console.log(chalk.yellow(`Note: Skipping image downloads because the --skip-images flag was used.\n`));
        }

        for (let i = 0; i < htmlFiles.length; i++) {
            const filePath = path.join(INPUT_DIR, htmlFiles[i]);
            await processPost(filePath, i + 1, htmlFiles.length);
            
            if (!options.skipImages) {
                await sleep(1000);
            }
        }

        console.log(chalk.green.bold(`\nAll done. You can find your converted posts in: ${OUTPUT_DIR}`));

        if (failedImages.length > 0) {
            console.log(chalk.bgRed.white.bold(`\n Heads up: ${failedImages.length} images failed to download \n`));
            console.log(chalk.yellow(`We tried a few times, but the following images couldn't be saved. You'll need to grab these manually and place them in the corresponding article folders.`));
            console.log(chalk.gray(`--------------------------------------------------------------------------------`));
            
            failedImages.forEach((item, index) => {
                console.log(chalk.bold.red(`${index + 1}. Article: `) + item.article);
                console.log(chalk.cyan(`   File Name: `) + item.imageName);
                console.log(chalk.cyan(`   URL to download: `) + chalk.underline(item.url));
                console.log(chalk.gray(`--------------------------------------------------------------------------------`));
            });
        }

    } catch (error) {
        console.error(chalk.red('\nSomething went wrong during the execution:'), error);
    }
}

main();
