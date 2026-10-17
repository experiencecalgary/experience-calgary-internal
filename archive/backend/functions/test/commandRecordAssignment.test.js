'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {canAssignTo, assignmentActor, assertRecordAssignment} = require('../lib/command/commandRecordAssignment');
const actor = (roleId, repId='7') => ({uid:'leader',roleId,userData:{userType:'rep',repId}});
const target = {userType:'rep',repId:'20',active:true,programDirectorRepId:'7',directorRepId:'8'};

test('platform admin can assign any active rep but not inactive or customer accounts',()=>{
 const admin={uid:'admin',userData:{role:'platform_admin'}};
 assert.equal(canAssignTo(admin,'other',target),true);
 assert.equal(canAssignTo(admin,'other',{...target,active:false}),false);
 assert.equal(canAssignTo(admin,'other',{...target,userType:'customer'}),false);
});
test('PD scope uses programDirectorRepId; Regionals use directorRepId for all director levels',()=>{
 assert.equal(canAssignTo(actor('ROLE7'),'member',target),true);
 assert.equal(canAssignTo(actor('ROLE7','9'),'member',target),false);
 for(const role of ['ROLE8','ROLE9','ROLE10','ROLE11']) assert.equal(canAssignTo(actor(role,8),'member',target),true);
 assert.equal(canAssignTo(actor('ROLE6'),'member',target),false);
 assert.equal(canAssignTo(actor('ROLE7'),'leader',{...target,repId:7}),true);
});
test('current role is loaded from canonical reps record, not a client or stale user role',async()=>{
 const db={collection:()=>({doc:()=>({get:async()=>({exists:true,data:()=>({currentRoleId:'ROLE6',active:true})})})})};
 const authority=await assignmentActor(db,'leader',{repId:'7',roleId:'ROLE7'});
 assert.equal(canAssignTo(authority,'member',target),false);
});
test('source and destination both require team membership; viewer ACL cannot authorize transfer',async()=>{
 let source={...target,programDirectorRepId:'outside'};
 const db={collection:()=>({doc:()=>({get:async()=>({exists:true,data:()=>source})})})};
 const dest={id:'destination',parent:{id:'users'},get:async()=>({exists:true,data:()=>target})};
 await assert.rejects(assertRecordAssignment(db,actor('ROLE7'),{assignedToUid:'outside',viewerUids:['leader'],teamRepIds:['7']},dest),/own records/);
 source={...target,active:false};
 await assertRecordAssignment(db,actor('ROLE7'),{assignedToUid:'member'},dest);
 await assertRecordAssignment(db,{uid:'admin',userData:{role:'platform_admin'}},{assignedToUid:'any'},dest);
 await assert.rejects(assertRecordAssignment(db,actor('ROLE7'),{},dest),/unowned/);
});

const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
for (const kind of ['People', 'Organizations']) {
 test(`bulk ${kind} permits admin reassignment and rejects cross-team leaders before writes`, async () => {
  const collection = kind === 'People' ? 'commandPeople' : 'commandOrganizations';
  let userData={role:'platform_admin',userType:'rep'};
  let writes=0;
  const record={assignedToUid:'outside',ownerUid:'outside'};
  const db={
   doc:p=>({id:p.split('/')[1],path:p,parent:{id:p.split('/')[0]},get:async()=>({exists:true,data:()=>target})}),
   collection:name=>({doc:id=>name==='reps'?{get:async()=>({exists:true,data:()=>({currentRoleId:'ROLE7',active:true})})}:name==='users'?{get:async()=>({exists:true,data:()=>({...target,programDirectorRepId:'outside'})})}:{id:'event'}}),
   getAll:async(...refs)=>refs.map(ref=>({exists:true,ref,updateTime:'snapshot-version',data:()=>record})),
   batch:()=>({update:(_ref,_data,precondition)=>{assert.equal(precondition.lastUpdateTime,'snapshot-version');},create:()=>{},commit:async()=>{writes++;}}),
  };
  const admin={firestore:Object.assign(()=>db,{FieldValue:{serverTimestamp:()=>1,delete:()=>null}})};
  const filename=path.join(__dirname,`../lib/command/bulkUpdateCommand${kind}.js`);
  const module={exports:{}};
  const customRequire=name=>{
   if(name==='firebase-admin')return admin;
   if(name==='./commandPersonUtils')return {PEOPLE_COLLECTION:'commandPeople',ALLOWED_STAGES:new Set(['New']),requireAuth:()=> 'admin',requireCommandAccess:async()=>({userRef:{id:'admin',path:'users/admin'},userData})};
   if(name==='./commandAccessMetadata')return {buildCommandAccessMetadata:async()=>({assignedToUid:'target',assignedToName:'Target'})};
   if(name==='./commandRecordAssignment')return require('../lib/command/commandRecordAssignment');
   return require(name);
  };
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{require:customRequire,module,exports:module.exports});
  const service=module.exports[`bulkUpdateCommand${kind}Service`];
  const request={data:{operation:'assign',assignedToRefPath:'users/target',[kind==='People'?'personRefPaths':'organizationRefPaths']:[`${collection}/one`]}};
  await service(request);assert.equal(writes,1);
  userData={repId:'7',userType:'rep'};
  await assert.rejects(service(request),/own records/);assert.equal(writes,1);
 });
}
