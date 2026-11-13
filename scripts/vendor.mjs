import fs from 'node:fs';
fs.mkdirSync('public/vendor',{recursive:true});
for(const [from,to] of [['node_modules/marked/lib/marked.umd.js','public/vendor/marked.umd.js'],['node_modules/dompurify/dist/purify.min.js','public/vendor/purify.min.js']]) fs.copyFileSync(from,to);
fs.mkdirSync('docs/licenses',{recursive:true});
for(const [from,to] of [['node_modules/marked/LICENSE','marked-LICENSE.txt'],['node_modules/dompurify/LICENSE','DOMPurify-LICENSE.txt'],['node_modules/dompurify/LICENSE-MPL','DOMPurify-LICENSE-MPL.txt']]) fs.copyFileSync(from,'docs/licenses/'+to);
console.log('Copied locked Markdown renderer, sanitizer and their redistribution licenses.');
