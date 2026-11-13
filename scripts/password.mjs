import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
const dir=path.resolve('docs/private');fs.mkdirSync(dir,{recursive:true,mode:0o700});
const filename=path.join(dir,'admin-access.json');
if(fs.existsSync(filename)&&!process.argv.includes('--rotate')){console.error('Credentials already exist. Use --rotate to deliberately create a new password.');process.exit(1);}
const previous=fs.existsSync(filename)?JSON.parse(fs.readFileSync(filename,'utf8')):{};
const password=crypto.randomBytes(24).toString('base64url');const hash=await bcrypt.hash(password,12);
const username=process.env.BC_ADMIN_USERNAME||previous.username||'admin';
const access={username,password,url:process.env.BC_APP_ORIGIN||previous.url||'http://127.0.0.1:8787',created_at:new Date().toISOString()};
fs.writeFileSync(filename,JSON.stringify(access,null,2)+'\n',{mode:0o600});fs.chmodSync(filename,0o600);
fs.writeFileSync(path.join(dir,'admin-secret.json'),JSON.stringify({ADMIN_PASSWORD_HASH:hash}),{mode:0o600});
fs.writeFileSync('.dev.vars',`ADMIN_USERNAME=${JSON.stringify(username)}\nADMIN_PASSWORD_HASH=${JSON.stringify(hash)}\nENVIRONMENT="local"\nAPP_ORIGIN="http://127.0.0.1:8787"\n`,{mode:0o600});
console.log('Created private administrator access file and password hash. Password is not printed.');
