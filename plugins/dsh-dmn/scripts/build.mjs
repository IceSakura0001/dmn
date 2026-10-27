import{mkdirSync,readFileSync,writeFileSync}from'node:fs';
const root=new URL('../',import.meta.url);mkdirSync(new URL('lib/',root),{recursive:true});
const source=readFileSync(new URL('src/client.cjs',root),'utf8');
writeFileSync(new URL('lib/client.js',root),`window.__ModuleLoader__.load({id:'dsh-dmn',factory:function(require){var module={exports:{}};var exports=module.exports;\n${source}\nreturn module.exports.makePlugin(require);}});\n`);
