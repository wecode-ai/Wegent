// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTranslation } from '@/hooks/useTranslation'
import { ImageGenerationConfig } from '@/apis/models'

export interface ImageConfigState {
  imageSize: string
  imageResponseFormat: 'url' | 'b64_json'
  imageOutputFormat: 'jpeg' | 'png'
  imageWatermark: boolean
  imageMaxImages: number | undefined
}

export interface ImageConfigSectionProps {
  config: ImageConfigState
  onChange: (config: Partial<ImageConfigState>) => void
}

/**
 * Image generation model configuration section
 * Handles size, response format, output format, watermark, and max images settings
 */
export const ImageConfigSection: React.FC<ImageConfigSectionProps> = ({ config, onChange }) => {
  const { t } = useTranslation()

  return (
    <div className="space-y-4 p-4 bg-muted rounded-lg">
      <h4 className="text-sm font-medium text-text-secondary">
        {t('common:models.image_config_title', '图像生成配置')}
      </h4>

      {/* Basic image settings */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="image_size" className="text-sm font-medium">
            {t('common:models.image_size', '图像尺寸')}
          </Label>
          <Select value={config.imageSize} onValueChange={v => onChange({ imageSize: v })}>
            <SelectTrigger className="bg-base">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1024x1024">1024x1024 (1:1)</SelectItem>
              <SelectItem value="1792x1024">1792x1024 (16:9)</SelectItem>
              <SelectItem value="1024x1792">1024x1792 (9:16)</SelectItem>
              <SelectItem value="2048x2048">2048x2048 (2K)</SelectItem>
              <SelectItem value="3072x3072">3072x3072 (3K)</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-text-muted">
            {t('common:models.image_size_hint', '生成图像的分辨率')}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="image_max_images" className="text-sm font-medium">
            {t('common:models.image_max_images', '最大图片数')}
          </Label>
          <Input
            id="image_max_images"
            type="number"
            min={1}
            max={10}
            value={config.imageMaxImages || ''}
            onChange={e => onChange({ imageMaxImages: parseInt(e.target.value) || undefined })}
            placeholder="1-10"
            className="bg-base"
          />
          <p className="text-xs text-text-muted">
            {t('common:models.image_max_images_hint', '单次请求最多生成的图片数量')}
          </p>
        </div>
      </div>

      {/* Output settings */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="image_response_format" className="text-sm font-medium">
            {t('common:models.image_response_format', '响应格式')}
          </Label>
          <Select
            value={config.imageResponseFormat}
            onValueChange={(v: 'url' | 'b64_json') => onChange({ imageResponseFormat: v })}
          >
            <SelectTrigger className="bg-base">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="url">URL</SelectItem>
              <SelectItem value="b64_json">Base64 JSON</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-text-muted">
            {t('common:models.image_response_format_hint', 'URL 返回图片链接，Base64 返回编码数据')}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="image_output_format" className="text-sm font-medium">
            {t('common:models.image_output_format', '输出格式')}
          </Label>
          <Select
            value={config.imageOutputFormat}
            onValueChange={(v: 'jpeg' | 'png') => onChange({ imageOutputFormat: v })}
          >
            <SelectTrigger className="bg-base">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="png">PNG</SelectItem>
              <SelectItem value="jpeg">JPEG</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Watermark toggle */}
      <div className="flex items-center justify-between py-2">
        <div>
          <Label className="text-sm font-medium">
            {t('common:models.image_watermark', '水印')}
          </Label>
          <p className="text-xs text-text-muted">
            {t('common:models.image_watermark_hint', '是否在生成的图片上添加水印')}
          </p>
        </div>
        <Select
          value={config.imageWatermark ? 'true' : 'false'}
          onValueChange={v => onChange({ imageWatermark: v === 'true' })}
        >
          <SelectTrigger className="w-24 bg-base">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="true">{t('common:yes', '是')}</SelectItem>
            <SelectItem value="false">{t('common:no', '否')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}

/**
 * Get default image config state
 */
export function getDefaultImageConfig(): ImageConfigState {
  return {
    imageSize: '1024x1024',
    imageResponseFormat: 'url',
    imageOutputFormat: 'png',
    imageWatermark: false,
    imageMaxImages: undefined,
  }
}

/**
 * Convert ImageConfigState to ImageGenerationConfig for API
 */
export function toImageGenerationConfig(state: ImageConfigState): ImageGenerationConfig {
  return {
    size: state.imageSize,
    response_format: state.imageResponseFormat,
    output_format: state.imageOutputFormat,
    watermark: state.imageWatermark,
    max_images: state.imageMaxImages,
  }
}

/**
 * Convert ImageGenerationConfig from API to ImageConfigState
 */
export function fromImageGenerationConfig(config: ImageGenerationConfig): ImageConfigState {
  return {
    imageSize: config.size || '1024x1024',
    imageResponseFormat: config.response_format || 'url',
    imageOutputFormat: config.output_format || 'png',
    imageWatermark: config.watermark ?? false,
    imageMaxImages: config.max_images,
  }
}

export default ImageConfigSection
