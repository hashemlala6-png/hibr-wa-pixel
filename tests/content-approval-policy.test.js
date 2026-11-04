'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {latestContentApproval,hasLatestApprovedContent}=require('../netlify/functions/content-approval-policy');

test('allows balance payment and final delivery after the latest content approval',()=>{
  const rows=[
    {id:'a1',projectId:'p1',kind:'content',status:'changes_requested',createdAt:'2026-01-01T10:00:00.000Z'},
    {id:'a2',projectId:'p1',kind:'content',status:'approved',createdAt:'2026-01-01T11:00:00.000Z'}
  ];
  assert.equal(hasLatestApprovedContent(rows,'p1'),true);
  assert.equal(latestContentApproval(rows,'p1').id,'a2');
});

test('does not reuse an older approval after the client requests changes on a newer version',()=>{
  const rows=[
    {id:'old',projectId:'p1',kind:'content',status:'approved',createdAt:'2026-01-01T10:00:00.000Z'},
    {id:'new',projectId:'p1',kind:'content',status:'changes_requested',createdAt:'2026-01-01T11:00:00.000Z'}
  ];
  assert.equal(hasLatestApprovedContent(rows,'p1'),false);
  assert.equal(latestContentApproval(rows,'p1').id,'new');
});

test('ignores approvals for other projects and non-content approval types',()=>{
  const rows=[
    {id:'design',projectId:'p1',kind:'design',status:'approved',createdAt:'2026-01-01T12:00:00.000Z'},
    {id:'other',projectId:'p2',kind:'content',status:'approved',createdAt:'2026-01-01T13:00:00.000Z'}
  ];
  assert.equal(hasLatestApprovedContent(rows,'p1'),false);
  assert.equal(latestContentApproval(rows,'p1'),null);
});

test('handles missing or invalid approval collections safely',()=>{
  assert.equal(hasLatestApprovedContent(null,'p1'),false);
  assert.equal(hasLatestApprovedContent([], 'p1'),false);
});
