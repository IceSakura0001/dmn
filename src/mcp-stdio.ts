import {nativeOwnership} from './native-instance.ts';
import {nativeOperator} from './native-client.ts';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import YAML from 'yaml';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { DmnStore } from './store.ts';
import { DshRootRuntime } from './dsh-runtime.ts';
import { OperatorService } from './operator.ts';
import { createOperatorMcp } from './mcp.ts';

// Launch arguments are trusted host configuration, never MCP tool parameters.
const [rootArg,dbArg]=process.argv.slice(2);
if(!rootArg){process.stderr.write('Usage: node --import tsx src/mcp-stdio.ts <workspace> [database]\n');process.exit(2);}
const root=resolve(rootArg),database=resolve(dbArg??resolve(root,'.dmn/dmn.sqlite'));
mkdirSync(dirname(database),{recursive:true});
let store:DmnStore|undefined;
try{
  const owned=nativeOwnership(database);
  if(!owned)store=new DmnStore(database);
  const service=owned?nativeOperator(database):new OperatorService(store!,YAML.parse(readFileSync(resolve(root,'config/nodes.deepseek.yaml'),'utf8')),new DshRootRuntime({root:store!.runtimeRoot,workspace:root}));
  const mcp=createOperatorMcp(service);
  let closing=false;
  const close=async()=>{if(closing)return;closing=true;await mcp.stop();store?.close();};
  const transport=new StdioServerTransport();
  await mcp.server.connect(transport);
  // SDK owns transport.onclose; stdin lifecycle is independent of that callback.
  process.stdin.on('end',()=>void close());
  for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>void close());
}catch{store?.close();process.stderr.write('DMN MCP initialization failed. Check local paths, configuration and schema.\n');process.exitCode=1;}
