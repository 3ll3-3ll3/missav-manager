import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("十万条结构化记录可通过索引分页、筛选和排序，不加载全库",{timeout:20_000},()=>{
  const db=new DatabaseSync(":memory:");
  db.exec("CREATE TABLE permanent_records(id TEXT PRIMARY KEY,tool TEXT,status TEXT,primary_value TEXT,updated_at TEXT);CREATE INDEX tool_status_updated ON permanent_records(tool,status,updated_at);");
  const insert=db.prepare("INSERT INTO permanent_records VALUES(?,?,?,?,?)");
  db.exec("BEGIN");for(let index=0;index<100_000;index+=1)insert.run(String(index).padStart(6,"0"),index%5===0?"missav":"twitter",index%3===0?"ready":"new",`CODE-${index}`,new Date(1_700_000_000_000+index*1000).toISOString());db.exec("COMMIT");
  const started=performance.now();const rows=db.prepare("SELECT id,primary_value FROM permanent_records WHERE tool=? AND status=? ORDER BY updated_at DESC,id DESC LIMIT 100 OFFSET 6000").all("missav","ready");const elapsed=performance.now()-started;
  assert.equal(rows.length,100);assert.ok(elapsed<1_500,`indexed page took ${elapsed.toFixed(1)} ms`);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM permanent_records").get().count,100_000);db.close();
});
