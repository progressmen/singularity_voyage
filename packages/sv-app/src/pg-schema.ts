/**
 * PostgreSQL 建表入口。
 *
 * DDL 统一维护在 `sql/schema.sql`：服务启动时自动执行，迁移时也可直接用 psql 执行，
 * 避免代码与迁移脚本出现两份建表语句。`src` 与构建产物 `lib` 都在包根目录下一层，
 * 因此 `../sql/schema.sql` 在源码运行与打包运行下都能定位到。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Pool } from 'pg'

const SCHEMA_FILE = join(import.meta.dirname, '..', 'sql', 'schema.sql')

/** 执行完整表结构脚本（幂等，可重复执行）。 */
export async function applySchema(pool: Pool): Promise<void> {
  const sql = await readFile(SCHEMA_FILE, 'utf8')
  await pool.query(sql)
}
