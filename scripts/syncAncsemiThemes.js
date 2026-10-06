'use strict';
const {execFileSync}=require('child_process');
const fs=require('fs');
const os=require('os');
const path=require('path');
const root=path.resolve(__dirname,'..');
const themesDir=path.join(root,'themes');
const dataDir=process.env.HAVEN_DATA_DIR||path.join(os.homedir(),'.local','share','haven-amniscient');
const db=path.join(dataDir,'haven.db');
const prevDir=path.join(dataDir,'theme-sync-prev');
const git=(args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'});
const ver=(text)=>{const m=/@version\s+([0-9]+(?:\.[0-9]+)*)/i.exec(text||'');return m?m[1].split('.').map(n=>Number(n)||0):[0];};
const cmp=(a,b)=>{const n=Math.max(a.length,b.length);for(let i=0;i<n;i++){const d=(a[i]||0)-(b[i]||0);if(d)return d;}return 0;};
const shim=(name,text)=>/^braid(-light)?\.theme\.css$/.test(name)&&!/@haven-layout\b/.test(text)?text.replace(/(\r?\n) \*\//,'$1 * @haven-layout BraidLayout$1 */'):text;
git(['fetch','origin']);
const list=git(['ls-tree','-r','--name-only','origin/main','--','themes']).split('\n').filter(f=>f.endsWith('.theme.css'));
const changed=[];
for(const rel of list){
  const name=path.basename(rel);
  const upstream=shim(name,git(['show',`origin/main:${rel}`]));
  const dest=path.join(themesDir,name);
  const cur=fs.existsSync(dest)?fs.readFileSync(dest,'utf8'):'';
  if(cur===upstream)continue;
  if(cur&&cmp(ver(cur),ver(upstream))>0){console.log(`keep ${name} ${ver(cur).join('.')} (newer than ancsemi ${ver(upstream).join('.')})`);continue;}
  fs.mkdirSync(prevDir,{recursive:true});
  cur&&fs.writeFileSync(path.join(prevDir,name),cur);
  fs.writeFileSync(dest,upstream);
  changed.push(`${cur?'updated':'added'} ${name} ${ver(upstream).join('.')}`);
}
let published=[];
try{published=JSON.parse(execFileSync('sqlite3',[db,"SELECT value FROM server_settings WHERE key='published_themes';"],{encoding:'utf8'}).trim()||'[]');}catch{published=[];}
const have=new Set(Array.isArray(published)?published:[]);
const added=list.map(f=>path.basename(f)).filter(f=>!have.has(f));
if(added.length){
  const value=JSON.stringify([...(Array.isArray(published)?published:[]),...added]).replaceAll("'","''");
  execFileSync('sqlite3',[db,`INSERT INTO server_settings(key,value) VALUES('published_themes','${value}') ON CONFLICT(key) DO UPDATE SET value=excluded.value;`]);
}
console.log(changed.length?changed.join('\n'):'themes already match ancsemi/Haven');
added.length&&console.log('published '+added.join(', '));
