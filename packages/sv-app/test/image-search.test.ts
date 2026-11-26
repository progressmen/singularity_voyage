/* 网页配图提取纯函数测试（node --test，零依赖）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { extractPageImages, isUsableImageUrl, resolveImageUrl } from '../src/image-search.ts'

test('resolveImageUrl：补全相对地址，拒绝 data 与非 http 协议', () => {
  assert.equal(resolveImageUrl('/img/a.png', 'https://example.com/news/1.html'), 'https://example.com/img/a.png')
  assert.equal(resolveImageUrl('//cdn.example.com/a.jpg', 'https://example.com/'), 'https://cdn.example.com/a.jpg')
  assert.equal(resolveImageUrl('data:image/png;base64,AAA', 'https://example.com/'), undefined)
  assert.equal(resolveImageUrl('javascript:alert(1)', 'https://example.com/'), undefined)
})

test('isUsableImageUrl：过滤图标、统计像素与非图片地址', () => {
  assert.equal(isUsableImageUrl('https://example.com/photo/main.jpg'), true)
  assert.equal(isUsableImageUrl('https://example.com/photo/main.jpg?image=1'), true)
  assert.equal(isUsableImageUrl('https://example.com/favicon.ico'), false)
  assert.equal(isUsableImageUrl('https://example.com/logo.png'), false)
  assert.equal(isUsableImageUrl('https://example.com/page.html'), false)
})

test('extractPageImages：优先 og:image，补全相对地址并去重', () => {
  const html = `
    <html><head>
      <meta property="og:image" content="//cdn.example.com/cover.jpg">
      <meta property="og:image" content="https://example.com/logo.png">
      <meta name="twitter:image" content="/img/second.webp">
    </head><body>
      <img src="/img/body.png" width="800" height="600">
    </body></html>`
  const images = extractPageImages(html, 'https://example.com/news/1.html')
  assert.deepEqual(images, [
    'https://cdn.example.com/cover.jpg',
    'https://example.com/img/second.webp',
    'https://example.com/img/body.png',
  ])
})

test('extractPageImages：没有 og 时回落到正文图片，跳过小图标与 tracking 像素', () => {
  const html = `
    <img src="/icons/small.png" width="32" height="32">
    <img src="/tracking/pixel.gif">
    <img src="/photos/scene.jpg" width="900">
    <img src="/photos/scene.jpg">`
  const images = extractPageImages(html, 'https://example.com/post')
  assert.deepEqual(images, ['https://example.com/photos/scene.jpg'])
})

test('extractPageImages：最多返回 4 张', () => {
  const html = Array.from({ length: 8 }, (_, index) => `<img src="/p/${index}.jpg" width="600">`).join('')
  assert.equal(extractPageImages(html, 'https://example.com/').length, 4)
})
