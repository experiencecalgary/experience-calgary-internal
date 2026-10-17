'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const brand=require('../routes/command/commandWebsiteBrand')._test;
const migration=require('../routes/command/commandLeadMigration')._test;
const dashboard=require('../routes/command/commandDashboardAutomation')._test;

test('asset discovery chooses largest srcset regardless of source ordering',()=>{
 assert.equal(brand.srcsetUrl('/large.webp 2400w, /small.webp 400w, /medium.webp 1200w'),'/large.webp');
 assert.equal(brand.srcsetUrl('/retina.png 3x, /normal.png 1x'),'/retina.png');
 const rows=brand.imageCandidates('<img src="/thumb.jpg" srcset="/large.jpg 2000w, /thumb.jpg 200w" class="hero">','https://example.com');
 assert.equal(rows[0].url,'https://example.com/large.jpg');
});
test('Organization-only branding enforces current access and rejects mismatched Lead context',async()=>{
 const data={ownerUid:'rep',organization:'Business'};
 const org={path:'commandOrganizations/o',parent:{id:'commandOrganizations'},get:async()=>({exists:true,data:()=>data})};
 const lead={path:'commandLeads/l',get:async()=>({exists:true,data:()=>({ownerUid:'rep',subjectOrganizationRef:org})})};
 const ctx={uid:'rep',actor:{userData:{}},input:{organizationRefPath:org.path},db:{doc:p=>p===lead.path?lead:{...org,path:p}}};
 assert.equal((await brand.leadOrganization(ctx)).organizationRef.path,org.path);
 await assert.rejects(brand.leadOrganization({...ctx,uid:'other'}),/access/);
 await assert.rejects(brand.leadOrganization({...ctx,input:{leadRefPath:lead.path,organizationRefPath:'commandOrganizations/other'}}),/does not match/);
 data.archived=true;await assert.rejects(brand.leadOrganization(ctx),/Active Organization/);
});
test('preview paging reads stored candidates, preserves committed state and cursor',async()=>{
 const values=['a','b','c'].map(id=>({id,data:()=>({candidateId:id,decision:'ready',status:id==='a'?'committed':'ready'})}));
 let after='';let size=0;
 const query={orderBy:()=>query,startAfter:x=>{after=x;return query;},limit:n=>{size=n;return query;},get:async()=>({docs:values.filter(d=>d.id>after).slice(0,size)})};
 const ctx={db:{collection:()=>({doc:()=>({get:async()=>({exists:true,data:()=>({status:'previewed',counts:{ready:3},scope:{}})}),collection:()=>query})})}};
 const first=await migration.migrationPage(ctx,'preview','',2);
 assert.equal(first.candidates[0].status,'committed');assert.equal(first.hasMore,true);assert.equal(first.nextCursor,'b');
 const last=await migration.migrationPage(ctx,'preview','b',2);assert.equal(last.candidates[0].candidateId,'c');assert.equal(last.hasMore,false);
});
test('global scope preserves filters when supplied and admin protection',()=>{
 assert.equal(migration.scopeMatches({},{}),true);
 assert.equal(migration.scopeMatches({assignedToUid:'rep'},{repUid:'other'}),false);
 assert.throws(()=>migration.assertPlatformAdmin({userData:{userType:'rep'}}),/platform administrator/);
 assert.deepEqual(migration.counts([{decision:'ready'},{decision:'ambiguous'},{decision:'contact_only'}]),{ready:1,already_migrated:0,ambiguous:1,contact_only:1});
});
test('stale definition is imported seven days with no action and excludes closed Leads',()=>{
 const now=Date.now(), importedAt={toMillis:()=>now-8*86400000};
 assert.equal(dashboard.isStaleImportedRecord({stage:'New',status:'active',importedAt},false,now),true);
 assert.equal(dashboard.isStaleImportedRecord({stage:'New',status:'active',importedAt},true,now),false);
 assert.equal(dashboard.isStaleImportedRecord({stage:'New',status:'won',importedAt},false,now),false);
});

test('migration commits the candidate only after history linking succeeds', async () => {
 const writes=[]; const ref={set:async value=>writes.push(value)};
 await assert.rejects(migration.finishCandidate(ref, async()=>{throw new Error('link interrupted');}), /link interrupted/);
 assert.equal(writes.length,0);
 const result=await migration.finishCandidate(ref,async()=>{assert.equal(writes.length,0);return {linked:3};});
 assert.equal(result.linked,3);assert.equal(writes[0].status,'committed');
});

test('migration preserves original import metadata rather than resetting the stale clock', () => {
 const importedAt={toMillis:()=>1234};
 const inherited=migration.inherited({organizationRefPath:'commandOrganizations/o',personRefPaths:[]},new Map(),new Map([['commandOrganizations/o',{exists:true,data:()=>({importedAt,importBatchId:'batch'})}]]));
 assert.equal(inherited.importedAt,importedAt);assert.equal(inherited.importBatchId,'batch');
});

test('dashboard activity targets agree with their record type and retain contact fallback', () => {
 const doc={ref:{path:'commandConnections/c'}};
 const person={path:'commandPeople/p'}, org={path:'commandOrganizations/o'}, lead={path:'commandLeads/l'};
 assert.equal(dashboard.connectionRow(doc,{personRef:person}).relatedRefPath,person.path);
 assert.equal(dashboard.connectionRow(doc,{organizationRef:org}).relatedRefPath,org.path);
 const row=dashboard.connectionRow(doc,{recordType:'person',personRef:person,leadRef:lead});
 assert.equal(row.recordType,'lead');assert.equal(row.relatedRefPath,lead.path);
});
