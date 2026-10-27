import {copyFileSync,readFileSync,appendFileSync,constants} from 'node:fs';
import {resolve} from 'node:path';
import YAML from 'yaml';
// Explicit local installer; no credentials, sessions, default routes or other plugins are rewritten.
const profile=resolve(process.env.USERPROFILE??'','.dsh/profiles/desktop/cordis.patch.yml');
const text=readFileSync(profile,'utf8');
const doc=YAML.parse(text);
if(!Array.isArray(doc))throw Error('Unexpected Desktop patch format');
function has(v:unknown):boolean {return Array.isArray(v)?v.some(has):!!v&&typeof v==='object'&&('id' in v&&v.id==='mcp-dmn'||Object.values(v).some(has));}
if(has(doc)){console.error('mcp-dmn already configured; no changes.');process.exit(0);}
const backup=profile+'.dmn-p3-'+Date.now()+'.bak';copyFileSync(profile,backup,constants.COPYFILE_EXCL);
const root=resolve('.').replaceAll('\\','/'),node=process.execPath.replaceAll('\\','/');
const entry=[{insert:[{id:'mcp-dmn',name:'@deepseek-ai/dsh-mcp-client',config:{serverName:'dmn',transport:'stdio',command:node,args:['--import','tsx',root+'/src/mcp-stdio.ts',root],cwd:root,toolCallTimeoutMs:60000,failOnStartupError:false}}]}];
const patch=YAML.stringify(entry).trimEnd()+'\n        env:\n          DEEPSEEK_API_KEY: !!js process.env.DEEPSEEK_API_KEY\n';
appendFileSync(profile,'\n'+patch,'utf8');console.error(JSON.stringify({installed:'mcp-dmn',backup}));
