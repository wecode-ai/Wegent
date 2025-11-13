// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useState, useEffect, useMemo } from 'react';
import Modal from '@/features/common/Modal';
import { Button, App } from 'antd';
import { useUser } from '@/features/common/UserContext';
import { fetchGitInfo, saveGitToken } from '../services/github';
import { GitInfo } from '@/types/api';
import { useTranslation } from '@/hooks/useTranslation';

interface GitHubEditProps {
  isOpen: boolean;
  onClose: () => void;
  mode: 'add' | 'edit';
  editInfo: GitInfo | null;
}

const sanitizeDomainInput = (value: string) => {
  if (!value) return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const withoutProtocol = trimmed.replace(/^[a-zA-Z]+:\/\//, '');
  const domainOnly = withoutProtocol.split('/')[0];
  return domainOnly.trim().toLowerCase();
};

const isValidDomain = (value: string) => {
  if (!value) return false;
  const [host, port] = value.split(':');
  if (!host) return false;
  if (port !== undefined) {
    if (!/^\d{1,5}$/.test(port)) return false;
    const portNumber = Number(port);
    if (portNumber < 1 || portNumber > 65535) return false;
  }
  if (host === 'localhost') return true;
  const domainRegex = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(?:\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/;
  return domainRegex.test(host);
};

const GitHubEdit: React.FC<GitHubEditProps> = ({ isOpen, onClose, mode, editInfo }) => {
  const { user, refresh } = useUser();
  const { t } = useTranslation('common');
  const { message } = App.useApp();
  const [platforms, setPlatforms] = useState<GitInfo[]>([]);
  const [domain, setDomain] = useState('');
  const [token, setToken] = useState('');
  const [type, setType] = useState<GitInfo['type']>('github');
  const [tokenSaving, setTokenSaving] = useState(false);
  const isGitlabLike = type === 'gitlab' || type === 'gitee';

  const isGitlabDomainInvalid = useMemo(() => {
    if (!isGitlabLike || !domain) return false;
    return !isValidDomain(domain);
  }, [isGitlabLike, domain]);

  const hasGithubPlatform = useMemo(
    () => platforms.some(info => sanitizeDomainInput(info.git_domain) === 'github.com'),
    [platforms]
  );

  // Load platform info and reset form when modal opens
  useEffect(() => {
    if (isOpen && user) {
      fetchGitInfo(user).then(info => setPlatforms(info));
      if (mode === 'edit' && editInfo) {
        const sanitizedDomain = sanitizeDomainInput(editInfo.git_domain);
        setDomain(sanitizedDomain);
        setToken(editInfo.git_token);
        setType(editInfo.type);
      } else {
        setDomain('');
        setToken('');
        setType('github');
      }
    }
  }, [isOpen, user, mode, editInfo]);

  // Save logic
  const handleSave = async () => {
    if (!user) return;
    const sanitizedDomain = type === 'github' ? 'github.com' : sanitizeDomainInput(domain);
    const domainToSave = type === 'github' ? 'github.com' : sanitizedDomain;
    const tokenToSave = token.trim();
    if (!domainToSave || !tokenToSave) {
      message.error(t('github.error.required'));
      return;
    }
    if (isGitlabLike && !isValidDomain(domainToSave)) {
      message.error(t('github.error.invalid_domain'));
      setDomain(sanitizedDomain);
      return;
    }
    setTokenSaving(true);
    try {
      await saveGitToken(user, domainToSave, tokenToSave);
      onClose();
      await refresh();
    } catch (error) {
      message.error((error as Error)?.message || t('github.error.save_failed'));
    } finally {
      setTokenSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={mode === 'edit' && domain ? t('github.modal.title_edit') : t('github.modal.title_add')}
      maxWidth="md"
    >
      <div className="space-y-4">
        {/* Platform selection */}
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-2">
            {t('github.platform')}
          </label>
          <div className="flex gap-4">
            <label className="flex items-center gap-1 text-sm text-text-primary">
              <input
                type="radio"
                value="github"
                checked={type === 'github'}
                onChange={() => {
                  setType('github');
                  setDomain('github.com');
                }}
                disabled={hasGithubPlatform && !(mode === 'edit' && editInfo?.type === 'github')}
              />
              {t('github.platform_github')}
            </label>
            <label
              className="flex items-center gap-1 text-sm text-text-primary"
              title={t('github.platform_gitlab')}
            >
              <input
                type="radio"
                value="gitlab"
                checked={isGitlabLike}
                onChange={() => {
                  setType('gitlab');
                  setDomain('');
                }}
              />
              {t('github.platform_gitlab')}
            </label>
          </div>
        </div>
        {/* Domain input */}
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-2">
            {t('github.domain')}
          </label>
          <input
            type="text"
            value={type === 'github' ? 'github.com' : domain}
            onChange={e => {
              if (isGitlabLike) {
                setDomain(sanitizeDomainInput(e.target.value));
              }
            }}
            placeholder={type === 'github' ? 'github.com' : 'e.g. gitlab.example.com'}
            className="w-full px-3 py-2 bg-base border border-border rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-transparent"
            disabled={type === 'github'}
          />
          {isGitlabDomainInvalid && (
            <p className="mt-1 text-xs text-red-500">{t('github.error.invalid_domain')}</p>
          )}
        </div>
        {/* Token input */}
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-2">
            {t('github.token.title')}
          </label>
          <input
            type="password"
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder={
              type === 'github'
                ? t('github.token.placeholder_github')
                : t('github.token.placeholder_gitlab')
            }
            className="w-full px-3 py-2 bg-base border border-border rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-transparent"
          />
        </div>
        {/* Get guidance */}
        <div className="bg-surface border border-border rounded-md p-3">
          <p className="text-xs text-text-muted mb-2">
            <strong>
              {type === 'github' ? t('github.howto.github.title') : t('github.howto.gitlab.title')}
            </strong>
          </p>
          {type === 'github' ? (
            <>
              <p className="text-xs text-text-muted mb-2 flex items-center gap-1">
                {t('github.howto.step1_visit')}
                <a
                  href="https://github.com/settings/tokens"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:text-primary/80 underline truncate max-w-[220px] inline-block align-bottom"
                  title="https://github.com/settings/tokens"
                >
                  https://github.com/settings/tokens
                </a>
              </p>
              <p className="text-xs text-text-muted mb-2">{t('github.howto.github.step2')}</p>
              <p className="text-xs text-text-muted">{t('github.howto.github.step3')}</p>
            </>
          ) : (
            <>
              <p className="text-xs text-text-muted mb-2 flex items-center gap-1">
                {t('github.howto.step1_visit')}
                <a
                  href={
                    isGitlabLike && domain
                      ? `https://${domain}/-/profile/personal_access_tokens`
                      : '#'
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:text-primary/80 underline truncate max-w-[220px] inline-block align-bottom"
                  title={
                    isGitlabLike && domain
                      ? `https://${domain}/-/profile/personal_access_tokens`
                      : 'your-gitlab-domain/-/profile/personal_access_tokens'
                  }
                >
                  {isGitlabLike && domain
                    ? `https://${domain}/-/profile/personal_access_tokens`
                    : 'your-gitlab-domain/-/profile/personal_access_tokens'}
                </a>
              </p>
              <p className="text-xs text-text-muted mb-2">{t('github.howto.gitlab.step2')}</p>
              <p className="text-xs text-text-muted">{t('github.howto.gitlab.step3')}</p>
            </>
          )}
        </div>
      </div>
      {/* Bottom button area */}
      <div className="flex space-x-3 mt-6">
        <Button onClick={onClose} type="default" size="small" style={{ flex: 1 }}>
          {t('common.cancel')}
        </Button>
        <Button
          onClick={handleSave}
          disabled={
            (isGitlabLike && (!domain || isGitlabDomainInvalid)) || !token.trim() || tokenSaving
          }
          type="primary"
          size="small"
          loading={tokenSaving}
          style={{ flex: 1 }}
        >
          {tokenSaving ? t('github.saving') : t('github.save_token')}
        </Button>
      </div>
    </Modal>
  );
};

export default GitHubEdit;
