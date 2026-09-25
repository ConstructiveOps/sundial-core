/**
 * handler.js — Sundial Roofing Budget Lambda entry point.
 *
 * Identical shape to the solar budget handler; only the object, input field list, and
 * calc module differ. RECOMMENDED: merge this with the solar function into ONE budget
 * Lambda that routes by record Id key prefix (or an Object__c field on the platform
 * event) — Sundial_Solar__c -> solar calc, Sundial_Roofing__c -> roofing calc. The
 * Sundial_Budget_Recalc__e platform event is already object-agnostic (Record_Id__c).
 *
 * Flow: read inputs -> calculate -> update output fields -> build workbook snapshot ->
 *       upload to S3 SUNDIAL/{recordId}/ -> update status fields.
 */
const jsforce = require('jsforce');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { calculateBudget, MATERIALS } = require('./budgetCalc');
const { buildWorkbook, snapshotKey } = require('./budgetWorkbook');

const s3 = new S3Client({});
const BUCKET = process.env.S3_BUCKET || 'sfsolproj';

const INPUT_FIELDS = [
  'Name', 'Project_Name__c',
  'Squares_Shingle__c', 'Squares_Tile__c', 'Squares_Modified__c', 'Squares_Recoat__c',
  'Labor_Rate_Shingle__c', 'Labor_Rate_Tile__c', 'Labor_Rate_Modified__c', 'Labor_Rate_Recoat__c',
  'Roll_Off_Qty__c', 'Roll_Off_Cost__c', 'Misc_Other_Qty__c', 'Misc_Other_Cost__c',
  'Labor_Markup_Percent__c', 'Material_Markup_Percent__c', 'Other_Markup_Percent__c',
  'Commission_Markup_Percent__c', 'Burden_Rate__c',
  'Commission_Rate_Percent__c', 'Geo_Commission_Amount__c',
  'Job_City__c', 'City_Tax_Rate__c',
  'Warranty_Line_Item_Amount__c', 'Warranty_Cost__c', 'Contract_Presented_Amount__c',
  ...Object.keys(MATERIALS).flatMap((b) => [`Mat_${b}_Qty__c`, `Mat_${b}_Cost__c`]),
];

async function sfConnection() {
  // Org-standard JWT bearer flow (integration user) — same as the other Sundial Lambdas
  const conn = new jsforce.Connection({ loginUrl: process.env.SF_LOGIN_URL });
  await conn.authorize({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    // ...JWT assertion from SF_CLIENT_ID / SF_USERNAME / private key in Secrets Manager
  });
  return conn;
}

async function recalcOne(conn, recordId, source) {
  const rec = await conn.sobject('Sundial_Roofing__c').retrieve(recordId, { fields: INPUT_FIELDS });
  const { fields, cells } = calculateBudget(rec);

  const now = new Date();
  const key = snapshotKey(recordId, rec.Project_Name__c || rec.Name, now);
  const buffer = await buildWorkbook(cells, { recordId, generatedAt: now.toISOString() });

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: key, Body: buffer,
    ContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }));

  await conn.sobject('Sundial_Roofing__c').update({
    Id: recordId,
    ...fields,
    Budget_Last_Calculated__c: now.toISOString(),
    Budget_Calc_Status__c: 'Calculated',
    Budget_Calc_Error__c: null,
    Latest_Budget_File_Path__c: key,
  });

  // TODO: register file metadata in Supabase (category 'Budget') per docs/file-storage.md
  return { recordId, source, s3Key: key, fields };
}

exports.handler = async (event) => {
  const jobs = [];
  if (event.httpMethod || event.requestContext) {
    const recordId = event.pathParameters?.recordId || JSON.parse(event.body || '{}').recordId;
    jobs.push({ recordId, source: 'Button' });
  } else if (Array.isArray(event.Records)) {
    for (const r of event.Records) {
      const payload = JSON.parse(r.body);
      jobs.push({ recordId: payload.Record_Id__c, source: payload.Source__c || 'FieldTrigger' });
    }
  } else if (event.detail) {
    jobs.push({ recordId: event.detail.payload?.Record_Id__c, source: event.detail.payload?.Source__c || 'FieldTrigger' });
  }

  const conn = await sfConnection();
  const results = [];
  for (const j of jobs.filter((x) => x.recordId)) {
    try {
      results.push(await recalcOne(conn, j.recordId, j.source));
    } catch (err) {
      console.error('Roofing budget recalc failed', j.recordId, err);
      try {
        await conn.sobject('Sundial_Roofing__c').update({
          Id: j.recordId, Budget_Calc_Status__c: 'Error',
          Budget_Calc_Error__c: String(err.message || err).slice(0, 255),
        });
      } catch (e2) { console.error('Status writeback failed', e2); }
      if (event.httpMethod || event.requestContext) throw err;
    }
  }

  if (event.httpMethod || event.requestContext) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(results[0] || {}) };
  }
  return { processed: results.length };
};
