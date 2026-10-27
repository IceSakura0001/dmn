import{performNativeMaintenance}from'./native-maintenance.ts';import{DmnError}from'./errors.ts';
const database=process.argv[2];if(!database)throw Error('Trusted database argument required.');
process.once('message',async request=>{try{process.send?.({ok:true,result:await performNativeMaintenance(database,request)});}catch(error){process.send?.({ok:false,error:error instanceof DmnError?error.code:'STORAGE'});}finally{if(process.connected)process.disconnect();}});
process.on('disconnect',()=>{process.exitCode=0;});
