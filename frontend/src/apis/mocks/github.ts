// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { http, HttpResponse } from 'msw';

export const MOCK_REPOS = [
  {
    git_repo_id: 1,
    name: 'algorithm',
    git_repo: 'fengkuizhi/algorithm',
    git_url: 'https://github.com/fengkuizhi/algorithm.git',
    git_domain: 'github.com',
    private: false,
  },
  {
    git_repo_id: 2,
    name: 'wecode-bot',
    git_repo: 'wecode-bot/main',
    git_url: 'https://github.com/wecode-bot/main.git',
    git_domain: 'github.com',
    private: false,
  },
  {
    git_repo_id: 3,
    name: 'frontend',
    git_repo: 'project/frontend',
    git_url: 'https://github.com/project/frontend.git',
    git_domain: 'github.com',
    private: true,
  },
];

export const MOCK_BRANCHES = [
  { name: 'master', protected: true, default: true },
  { name: 'develop', protected: false, default: false },
  { name: 'feature/ui-updatelonglonglonglonglong', protected: false, default: false },
];

export const githubHandlers = [
  http.get('/api/github/validate-token', () => {
    return HttpResponse.json({ valid: true, user: { login: 'mock-user' } });
  }),
  // Repository list
  http.get('/api/github/repositories', () => {
    return HttpResponse.json(MOCK_REPOS);
  }),
  // Branch list
  http.get('/api/github/repositories/branches', () => {
    return HttpResponse.json(MOCK_BRANCHES);
  }),
];
