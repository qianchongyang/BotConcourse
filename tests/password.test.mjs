import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import bcrypt from 'bcryptjs';

test('local credential generation refuses accidental overwrite and rotation preserves identity',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'botconcourse-password-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const script=fileURLToPath(new URL('../scripts/password.mjs',import.meta.url));
  const env={...process.env};delete env.BC_ADMIN_USERNAME;delete env.BC_APP_ORIGIN;
  const run=(args=[],overrides={})=>spawnSync(process.execPath,[script,...args],{cwd:dir,env:{...env,...overrides},encoding:'utf8'});
  const read=()=>JSON.parse(fs.readFileSync(path.join(dir,'docs/private/admin-access.json'),'utf8'));
  assert.equal(run([],{BC_ADMIN_USERNAME:'test-admin',BC_APP_ORIGIN:'https://workspace.example.com'}).status,0);
  const before=read();assert.ok(before.password.length>=32);assert.equal(before.username,'test-admin');
  assert.equal(run().status,1);assert.ok(read().password===before.password);
  assert.equal(run(['--rotate']).status,0);const after=read();assert.ok(after.password!==before.password);
  assert.equal(after.username,before.username);assert.equal(after.url,before.url);
  const hash=JSON.parse(fs.readFileSync(path.join(dir,'docs/private/admin-secret.json'),'utf8')).ADMIN_PASSWORD_HASH;
  assert.ok(await bcrypt.compare(after.password,hash));
  assert.equal(fs.statSync(path.join(dir,'docs/private/admin-access.json')).mode&0o777,0o600);
});
