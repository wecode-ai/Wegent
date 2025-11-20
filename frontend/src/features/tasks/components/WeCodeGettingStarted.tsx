// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useEffect, useRef } from 'react';
import { Card } from '@/components/ui/card';
import {
  CodeBracketIcon,
  CloudIcon,
  ClipboardDocumentCheckIcon,
} from '@heroicons/react/24/outline';
import DiscountNotification from './DiscountNotification';

interface WeCodeGettingStartedProps {
  className?: string;
}

export default function WeCodeGettingStarted({ className = '' }: WeCodeGettingStartedProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const gettingStartedItems = [
    {
      icon: <CodeBracketIcon className="w-6 h-6" />,
      title: '在IDE中使用WeCode',
      description: '在您熟悉的开发环境中直接使用WeCode，提升开发效率',
      link: 'https://wiki.api.weibo.com/zh/weibo_rd/dev/wecode/wiki',
      cardClass: 'hover:bg-blue-50/50',
    },
    {
      icon: <CloudIcon className="w-6 h-6" />,
      title: '使用WeCode云IDE',
      description: '基于云端的集成开发环境，随时随地开始编码',
      link: 'https://space.intra.weibo.com/develop/code-server',
      cardClass: 'hover:bg-green-50/50',
    },
    {
      icon: <ClipboardDocumentCheckIcon className="w-6 h-6" />,
      title: '启用代码审查',
      description: '自动化代码审查，确保代码质量和团队协作',
      link: 'https://wiki.api.weibo.com/zh/weibo_rd/dev/wecode/agent/wecoder_agent',
      cardClass: 'hover:bg-purple-50/50',
    },
  ];

  const handleCardClick = (link: string) => {
    if (link && link !== '#') {
      window.open(link, '_blank', 'noopener,noreferrer');
    }
  };

  // 初始化时滚动到第一个卡片（左对齐）
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (container && window.innerWidth < 640) {
      // 只在移动端执行
      // 滚动到第一个卡片位置（左对齐）
      container.scrollLeft = 0;
    }
  }, []);

  return (
    <div className={`w-full ${className}`}>
      {/* 折扣通知 */}
      <div className="mb-6">
        <DiscountNotification />
      </div>

      {/* 标题区域 - 移动端紧凑布局 */}
      <div className="text-center mb-2 sm:mb-6">
        <h2 className="text-sm sm:text-xl font-semibold text-text-primary mb-0.5">
          开始使用WeCode
        </h2>
        <p className="text-text-secondary text-xs sm:text-sm px-2 sm:px-4">
          选择最适合您的方式开始编码之旅
        </p>
      </div>

      {/* 卡片容器 - 移动端横向滚动，桌面端网格布局 */}
      <div className="max-w-5xl mx-auto">
        {/* 移动端横向滚动 - 轮播预览效果 */}
        <div className="sm:hidden">
          <div
            ref={scrollContainerRef}
            className="flex gap-3 overflow-x-auto pb-2 scrollbar-hide snap-x snap-mandatory px-4"
            style={{
              scrollBehavior: 'smooth',
              scrollSnapType: 'x mandatory',
            }}
          >
            {gettingStartedItems.map((item, index) => (
              <Card
                key={index}
                className={`
                cursor-pointer transition-all duration-200
                hover:shadow-lg hover:-translate-y-1
                border border-border bg-surface
                ${item.cardClass}
                flex-shrink-0 w-[calc(40vw-12px)] h-48 min-w-[140px] max-w-[180px]
                snap-start
                p-4
              `}
                onClick={() => handleCardClick(item.link)}
              >
                <div className="text-center flex flex-col justify-center h-full">
                  {/* 图标 */}
                  <div
                    className="
                  inline-flex items-center justify-center
                  w-10 h-10 rounded-full mb-3
                  bg-muted border border-border
                "
                  >
                    <div className="text-primary">{item.icon}</div>
                  </div>

                  {/* 标题 */}
                  <h3 className="text-xs font-semibold text-text-primary mb-2 leading-tight">
                    {item.title}
                  </h3>

                  {/* 描述 */}
                  <p className="text-text-secondary text-xs leading-relaxed line-clamp-2">
                    {item.description}
                  </p>
                </div>
              </Card>
            ))}
          </div>
        </div>

        {/* 桌面端网格布局 */}
        <div className="hidden sm:grid grid-cols-2 lg:grid-cols-3 gap-6">
          {gettingStartedItems.map((item, index) => (
            <Card
              key={index}
              className={`
                cursor-pointer transition-all duration-200
                hover:shadow-lg hover:-translate-y-1
                border border-border bg-surface
                ${item.cardClass}
                p-5
              `}
              onClick={() => handleCardClick(item.link)}
            >
              <div className="text-center">
                <div
                  className="
                  inline-flex items-center justify-center
                  w-12 h-12 rounded-full mb-4
                  bg-muted border border-border
                "
                >
                  <div className="text-primary">{item.icon}</div>
                </div>

                {/* 标题 */}
                <h3 className="text-lg font-semibold text-text-primary mb-3">{item.title}</h3>

                {/* 描述 */}
                <p className="text-text-secondary text-sm leading-relaxed">{item.description}</p>
              </div>
            </Card>
          ))}
        </div>

        {/* 问题反馈群 */}
        <div className="mt-8 text-center">
          <span className="text-text-secondary text-sm ml-1">加入</span>
          <a
            href="https://qr.dingtalk.com/action/joingroup?code=v1,k1,s8zIEYd6GCOuoFaf1hSO4qxA+FSgubnJzwaUIsjRXho=&_dt_no_comment=1&origin=11? axb邀请你加入钉钉群聊WeCode代码助手，点击进入查看详情"
            style={{
              color: 'var(--vscode-textLink-foreground)',
              textDecoration: 'underline',
              textDecorationColor: '#3b82f6',
              textDecorationThickness: '2px',
              textUnderlineOffset: '2px',
            }}
            className="text-sm hover:opacity-80 font-medium"
          >
            微博WeCode钉钉群
          </a>
          <span className="text-text-secondary text-sm ml-1">参与讨论。</span>
        </div>
      </div>
    </div>
  );
}
