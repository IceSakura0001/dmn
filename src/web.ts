import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {DmnError,fail} from './errors.ts';
import {OperatorService} from './operator.ts';

/** Trusted local single-user UI. Never expose this listener on a public interface. */
export async function startWeb(service:OperatorService,port=4310){
 const token=randomBytes(32).toString('hex');
 let active:Promise<void>|undefined,timer:NodeJS.Timeout|undefined,stopped=false,requested=false;
 const wake=()=>{
  if(stopped)return;requested=true;if(timer)clearTimeout(timer);if(active)return;
  active=(async()=>{try{do{requested=false;await service.drain();}while(requested&&!stopped);}
   catch{process.stderr.write('DMN web worker stopped; inspect queue through CLI.\n');}
   finally{active=undefined;const due=service.nextWake();if(!stopped&&due&&Date.parse(due)>Date.now())timer=setTimeout(wake,Math.min(60000,Date.parse(due)-Date.now()));}
  })();
 };
 const assets=new Map([['/',['index.html','text/html; charset=utf-8']],['/app.js',['app.js','text/javascript; charset=utf-8']],['/style.css',['style.css','text/css; charset=utf-8']]]);
 const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const json=(status:number,data:unknown)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
  try{
   const address=server.address();const currentPort=typeof address==='object'&&address?address.port:port;
   const host=`127.0.0.1:${currentPort}`,origin=`http://${host}`;
   if(req.headers.host!==host || (req.headers.origin && req.headers.origin!==origin) || req.headers['sec-fetch-site']==='cross-site'){json(403,{error:'FORBIDDEN'});return;}
   const url=new URL(req.url??'/',origin);
   if(req.method==='GET'&&assets.has(url.pathname)){
    const [name,type]=assets.get(url.pathname)!;res.writeHead(200,{'content-type':type!});res.end(readFileSync(new URL(`../web/${name}`,import.meta.url)));return;
   }
   if(req.method==='GET'&&url.pathname==='/api/state'){json(200,{nodes:service.list(),topics:service.listTopics(),csrfToken:token});return;}
   if(req.method==='GET'&&url.pathname==='/api/metrics'){
    if([...url.searchParams.keys()].some(k=>k!=='topicId'))fail('VALIDATION','Unknown metric query field.');
    const topicId=url.searchParams.get('topicId');json(200,service.metrics(topicId===null?{}:{topicId}));return;
   }
   if(req.method==='GET'&&url.pathname==='/api/topic'){
    if([...url.searchParams.keys()].some(k=>!['topicId','limit','cursor','order'].includes(k)))fail('VALIDATION','Unknown message query field.');
    const input={topicId:url.searchParams.get('topicId')};const limit=url.searchParams.get('limit');json(200,{topic:service.get(input),messages:service.messages({...input,...(limit===null?{}:{limit:Number(limit)}),cursor:url.searchParams.get('cursor')??undefined,order:url.searchParams.get('order')??undefined})});return;
   }
   if(req.method!=='POST'){json(404,{error:'NOT_FOUND'});return;}
   if(req.headers['x-dmn-token']!==token || req.headers['content-type']!=='application/json'){json(403,{error:'FORBIDDEN'});return;}
   const chunks:Buffer[]=[];let size=0;
   for await(const chunk of req){size+=chunk.length;if(size>65536){json(413,{error:'BODY_TOO_LARGE'});return;}chunks.push(chunk);}
   let input:unknown;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{json(400,{error:'VALIDATION'});return;}
   let output:unknown;
   switch(url.pathname){
    case '/api/start':output=service.start(input);break;
    case '/api/send':output=service.send(input);break;
    case '/api/pause':output=service.pause(input);break;
    case '/api/resume':output=service.resume(input);break;
    case '/api/close':output=service.close(input);break;
    default:json(404,{error:'NOT_FOUND'});return;
   }
   json(200,output);if(['/api/start','/api/send','/api/resume'].includes(url.pathname))setImmediate(wake);
  }catch(error){json(error instanceof DmnError?400:500,{error:error instanceof DmnError?error.code:'INTERNAL'});}
 });
 server.requestTimeout=10000;server.headersTimeout=10000;
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 const address=server.address();if(!address||typeof address==='string')throw Error('Missing listener');
 return {port:address.port,async close(){stopped=true;if(timer)clearTimeout(timer);await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await active;}};
}
