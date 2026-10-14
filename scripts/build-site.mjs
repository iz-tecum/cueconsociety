import { cp, mkdir, readdir, rm, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.site-build');
const roots = ['index.html', 'about', 'admin', 'alumni', 'calendar', 'contact', 'events', 'faq', 'leadership', 'recruitment', 'newsletter', 'assets', 'headshots', 'horizontals', 'verticals', 'media', 'misc'];
const extensions = new Set(['.html', '.css', '.js', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico', '.gif', '.woff', '.woff2', '.mp4', '.pdf']);
const fontNotices = new Set([path.join('admin', 'fonts', 'OFL.txt'), path.join('admin', 'fonts', 'SOURCE.txt')]);
await rm(output, {recursive:true,force:true});
await mkdir(output, {recursive:true});
let count=0;
async function copy(relative) {
 const source=path.join(root, relative); const info=await stat(source);
 if(info.isDirectory()) { for(const name of await readdir(source)) if(!name.startsWith('.') && !['tests','private','node_modules'].includes(name)) await copy(path.join(relative,name)); return; }
 if((!extensions.has(path.extname(source)) && !fontNotices.has(relative)) || /(?:test|config-example)\./.test(relative)) return;
 const target=path.join(output,relative); await mkdir(path.dirname(target),{recursive:true}); await cp(source,target); count++;
}
for(const item of roots) await copy(item);
await writeFile(path.join(output,'_headers'), '/admin/*\n  X-Robots-Tag: noindex, nofollow\n  Cache-Control: no-store\n');
console.log(`Prepared ${count} public website assets. Private files and backend source excluded.`);
