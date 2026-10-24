import {putRecord,transaction,recordAudit} from './production-store.mjs';
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
export function cabinetControl(db,id){
 const row=db.prepare("SELECT data FROM records WHERE kind='cabinet_control' AND id=?").get(id);
 return row?JSON.parse(row.data):{id,paused:false,note:'',updatedAt:null};
}
export function assertNewRentalAllowed(db,id){
 if(cabinetControl(db,id).paused)fail(409,'New rentals are paused at this station');
}
export function saveCabinetControl(db,config,actor,body,time){
 if(!['owner','operator'].includes(actor.role))fail(403,'Your role cannot perform this action');
 if(!(config.wschargeCabinets||[]).includes(body.cabinetId))fail(404,'Cabinet not found');
 if(typeof body.paused!=='boolean'||typeof body.note!=='string'||body.note.trim().length<5||body.note.length>500)fail(400,'Provide a pause setting and handling note (5–500 characters)');
 return transaction(db,()=>{
  const before=cabinetControl(db,body.cabinetId);
  if(!Object.hasOwn(body,'expectedUpdatedAt')||body.expectedUpdatedAt!==before.updatedAt)fail(409,'Cabinet setting changed. Refresh before saving.');
  const control={id:body.cabinetId,paused:body.paused,note:body.note.trim(),updatedAt:new Date(Math.max(time,(Date.parse(before.updatedAt)||0)+1)).toISOString()};
  putRecord(db,'cabinet_control',control.id,control);
  recordAudit(db,actor.id,'cabinet.control',control.id,time,{before,after:control});
  return {control};
 });
}
