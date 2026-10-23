/**
 * 邮件通知单测：每日摘要触发判定与两类邮件正文。
 * 真实 SMTP 发送不在单测里跑（需要凭据）；mailer.py 由 CLI dry-run 冒烟。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { digestBody, digestSubject, isMailConfigured, reminderBody, shouldSendDigest } from '../src/mail-notifier.ts'
import type { SvMailConfig } from '../src/config-store.ts'
import type { TaskEntry } from '../src/tasks-store.ts'

function mail(patch: Partial<SvMailConfig> = {}): SvMailConfig {
  return {
    enabled: true,
    host: 'smtp.qq.com',
    port: 465,
    secure: true,
    user: 'me@qq.com',
    password: 'app-pass',
    from: '',
    to: 'me@qq.com',
    notifyOnReminder: true,
    digestAt: '08:30',
    ...patch,
  }
}

function task(patch: Partial<TaskEntry> = {}): TaskEntry {
  return {
    id: 't1',
    title: '交材料',
    recurrence: 'none',
    status: 'pending',
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  }
}

test('shouldSendDigest：到点且当天未发才触发', () => {
  const before = new Date(2026, 9, 23, 8, 29, 0)
  const at = new Date(2026, 9, 23, 8, 30, 0)
  const later = new Date(2026, 9, 23, 12, 0, 0)
  assert.equal(shouldSendDigest(before, '08:30', undefined), false)
  assert.equal(shouldSendDigest(at, '08:30', undefined), true)
  assert.equal(shouldSendDigest(later, '08:30', undefined), true)
  assert.equal(shouldSendDigest(at, '08:30', '2026-10-23'), false)
  assert.equal(shouldSendDigest(new Date(2026, 9, 24, 8, 30, 0), '08:30', '2026-10-23'), true)
})

test('shouldSendDigest：空或非法时间表示关闭', () => {
  const at = new Date(2026, 9, 23, 9, 0, 0)
  assert.equal(shouldSendDigest(at, '', undefined), false)
  assert.equal(shouldSendDigest(at, '8:3', undefined), false)
  assert.equal(shouldSendDigest(at, '24:00', undefined), false)
})

test('isMailConfigured：缺主机/账号/密码才视为不可用', () => {
  assert.equal(isMailConfigured(mail()), true)
  assert.equal(isMailConfigured(mail({ to: '' })), true, '收件人留空回落到账号')
  assert.equal(isMailConfigured(mail({ password: '' })), false)
  assert.equal(isMailConfigured(mail({ host: '' })), false)
  assert.equal(isMailConfigured(mail({ user: '' })), false)
})

test('reminderBody 含时间、重复规则与备注', () => {
  const dueAt = new Date(2026, 9, 23, 10, 0, 0).getTime()
  const body = reminderBody(task({ dueAt, recurrence: 'daily', notes: '带上身份证' }), dueAt + 60_000)
  assert.match(body, /待办提醒/)
  assert.match(body, /标题：交材料/)
  assert.match(body, /已逾期/)
  assert.match(body, /重复：每天/)
  assert.match(body, /带上身份证/)
})

test('digestBody 汇总未完成待办，逾期项单独分组', () => {
  const dueAt = new Date(2026, 9, 23, 10, 0, 0).getTime()
  const body = digestBody([task({ dueAt }), task({ id: 't2', title: '写周报' })], dueAt + 60_000)
  assert.match(body, /今日待办（2 项）/)
  assert.match(body, /已逾期（1 项）/)
  assert.match(body, /交材料.*已逾期/)
  assert.match(body, /其余待办/)
  assert.match(body, /写周报（无截止时间）/)
  assert.match(digestBody([], Date.now()), /今天没有未完成的待办/)
})

test('digestSubject 标注逾期数量', () => {
  const dueAt = new Date(2026, 9, 23, 10, 0, 0).getTime()
  assert.equal(
    digestSubject([task({ dueAt }), task({ id: 't2', title: '写周报' })], dueAt + 60_000),
    '[SV 日报] 10-23 待办 2 项（逾期 1）',
  )
  assert.equal(digestSubject([task({ id: 't2', title: '写周报' })], dueAt), '[SV 日报] 10-23 待办 1 项')
})
