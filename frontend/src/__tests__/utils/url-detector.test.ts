// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { isImageUrl, detectUrls, extractImageUrls, extractWebPageUrls } from '@/utils/url-detector'

describe('url-detector', () => {
  describe('isImageUrl', () => {
    describe('pathname with image extension', () => {
      it('should return true for URLs with .png extension', () => {
        expect(isImageUrl('https://example.com/image.png')).toBe(true)
      })

      it('should return true for URLs with .jpg extension', () => {
        expect(isImageUrl('https://example.com/photo.jpg')).toBe(true)
      })

      it('should return true for URLs with .jpeg extension', () => {
        expect(isImageUrl('https://example.com/photo.jpeg')).toBe(true)
      })

      it('should return true for URLs with .gif extension', () => {
        expect(isImageUrl('https://example.com/animation.gif')).toBe(true)
      })

      it('should return true for URLs with .webp extension', () => {
        expect(isImageUrl('https://example.com/image.webp')).toBe(true)
      })

      it('should return true for URLs with .svg extension', () => {
        expect(isImageUrl('https://example.com/icon.svg')).toBe(true)
      })

      it('should return true for URLs with query parameters after image extension', () => {
        expect(isImageUrl('https://example.com/image.png?width=100')).toBe(true)
      })

      it('should be case insensitive for extensions', () => {
        expect(isImageUrl('https://example.com/image.PNG')).toBe(true)
        expect(isImageUrl('https://example.com/image.Jpg')).toBe(true)
      })
    })

    describe('query parameter with image extension', () => {
      it('should return true for nanobanana-style URLs with image extension in query param', () => {
        const url =
          'https://test.image.com/backend/image_url?ikey=nanobanana2%2F2026%2F01%2F05%2Fab6b8a6cd3334873926f94bf64b432e1.png'
        expect(isImageUrl(url)).toBe(true)
      })

      it('should return true for URLs with file parameter containing image extension', () => {
        expect(isImageUrl('https://api.example.com/image?file=photo.jpg')).toBe(true)
      })

      it('should return true for URLs with path-like query parameter containing image extension', () => {
        expect(isImageUrl('https://api.example.com/get?path=/uploads/2024/image.png')).toBe(true)
      })

      it('should handle URL-encoded query parameters', () => {
        expect(isImageUrl('https://api.example.com/image?key=path%2Fto%2Fimage.png')).toBe(true)
      })

      it('should return true when any query param value ends with image extension', () => {
        expect(isImageUrl('https://api.example.com/get?type=photo&name=test.gif')).toBe(true)
      })
    })

    describe('non-image URLs', () => {
      it('should return false for regular web page URLs', () => {
        expect(isImageUrl('https://example.com/page')).toBe(false)
      })

      it('should return false for URLs with .html extension', () => {
        expect(isImageUrl('https://example.com/page.html')).toBe(false)
      })

      it('should return false for URLs with .pdf extension', () => {
        expect(isImageUrl('https://example.com/document.pdf')).toBe(false)
      })

      it('should return false for URLs with image-like text but no extension', () => {
        expect(isImageUrl('https://example.com/image')).toBe(false)
      })

      it('should return false for URLs where image extension is in the middle of path', () => {
        expect(isImageUrl('https://example.com/image.png.backup')).toBe(false)
      })
    })

    describe('edge cases', () => {
      it('should handle invalid URLs gracefully', () => {
        // Should not throw, and should check if the string contains image extension
        expect(isImageUrl('not-a-valid-url')).toBe(false)
        expect(isImageUrl('invalid.png')).toBe(true)
      })

      it('should handle empty string', () => {
        expect(isImageUrl('')).toBe(false)
      })
    })
  })

  describe('detectUrls', () => {
    it('should detect plain image URLs in text', () => {
      const text = 'Check out this image: https://example.com/photo.png'
      const urls = detectUrls(text)
      expect(urls).toHaveLength(1)
      expect(urls[0].url).toBe('https://example.com/photo.png')
      expect(urls[0].isImage).toBe(true)
    })

    it('should detect image URLs with extension in query parameter', () => {
      const text =
        '📌 生成图片\nhttps://api.example.com/image_url?ikey=path%2F2026%2F01%2F05%2Fab6b8a6cd3334873926f94bf64b432e1.png'
      const urls = detectUrls(text)
      expect(urls).toHaveLength(1)
      expect(urls[0].isImage).toBe(true)
    })

    it('should detect Markdown image syntax', () => {
      const text = 'Here is an image: ![alt text](https://example.com/image.png)'
      const urls = detectUrls(text)
      expect(urls).toHaveLength(1)
      expect(urls[0].isImage).toBe(true)
      expect(urls[0].altText).toBe('alt text')
    })

    it('should detect Markdown links with image URLs', () => {
      const text = 'Click [here](https://example.com/photo.jpg) to see the image'
      const urls = detectUrls(text)
      expect(urls).toHaveLength(1)
      expect(urls[0].isImage).toBe(true)
      expect(urls[0].linkText).toBe('here')
    })

    it('should distinguish between image and non-image URLs', () => {
      const text = 'Visit https://example.com/page and see https://example.com/image.png'
      const urls = detectUrls(text)
      expect(urls).toHaveLength(2)
      expect(urls[0].isImage).toBe(false)
      expect(urls[1].isImage).toBe(true)
    })
  })

  describe('extractImageUrls', () => {
    it('should extract only image URLs from text', () => {
      const text =
        'Visit https://example.com and see https://example.com/photo.png and https://api.example.com/image?file=test.jpg'
      const imageUrls = extractImageUrls(text)
      expect(imageUrls).toHaveLength(2)
      expect(imageUrls).toContain('https://example.com/photo.png')
      expect(imageUrls).toContain('https://api.example.com/image?file=test.jpg')
    })
  })

  describe('extractWebPageUrls', () => {
    it('should extract only non-image URLs from text', () => {
      const text = 'Visit https://example.com and see https://example.com/photo.png'
      const webUrls = extractWebPageUrls(text)
      expect(webUrls).toHaveLength(1)
      expect(webUrls).toContain('https://example.com')
    })
  })
})
