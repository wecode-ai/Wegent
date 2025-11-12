// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Task } from '@/types/api';
import { TaskListResponse } from '@/apis/tasks';
import { http, HttpResponse } from 'msw';

export const MOCK_TASKS: Task[] = [
  {
    id: 1,
    title: 'Implement user authentication',
    team_id: 1,
    git_url: 'https://github.com/example/project.git',
    git_repo: 'example/project',
    git_repo_id: 123,
    git_domain: 'github.com',
    branch_name: 'feature/auth',
    prompt: 'Implement JWT-based authentication for the application.',
    status: 'COMPLETED',
    progress: 100,
    batch: 1,
    result: { message: 'Authentication implemented successfully.' },
    error_message: '',
    user_id: 1,
    user_name: 'admin',
    created_at: '2024-07-20T10:00:00Z',
    updated_at: '2024-07-20T12:30:00Z',
    completed_at: '2024-07-20T12:30:00Z',
  },
  {
    id: 2,
    title: 'Design database schema',
    team_id: 1,
    git_url: 'https://github.com/example/project.git',
    git_repo: 'example/project',
    git_repo_id: 123,
    git_domain: 'github.com',
    branch_name: 'feature/db-schema',
    prompt: 'Design the initial database schema for users, posts, and comments.',
    status: 'RUNNING',
    progress: 50,
    batch: 1,
    result: {},
    error_message: '',
    user_id: 1,
    user_name: 'admin',
    created_at: '2024-07-21T09:00:00Z',
    updated_at: '2024-07-21T11:00:00Z',
    completed_at: '',
  },
  {
    id: 3,
    title: 'Set up CI/CD pipeline',
    team_id: 2,
    git_url: 'https://github.com/example/project.git',
    git_repo: 'example/project',
    git_repo_id: 123,
    git_domain: 'github.com',
    branch_name: 'feature/ci-cd',
    prompt: 'Configure a CI/CD pipeline using GitHub Actions.',
    status: 'PENDING',
    progress: 0,
    batch: 1,
    result: {},
    error_message: '',
    user_id: 2,
    user_name: 'developer',
    created_at: '2024-07-22T14:00:00Z',
    updated_at: '2024-07-22T14:00:00Z',
    completed_at: '',
  },
];

export const taskHandlers = [
  http.get('/api/tasks', ({ request }) => {
    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get('page') || '1');
    const limit = 10; // Default limit
    const status = url.searchParams.get('status');

    let filteredTasks = MOCK_TASKS;
    if (status) {
      filteredTasks = MOCK_TASKS.filter(task => task.status === status);
    }

    const total = filteredTasks.length;
    const paginatedTasks = filteredTasks.slice((page - 1) * limit, page * limit);

    const response: TaskListResponse = {
      total,
      items: paginatedTasks,
    };
    return HttpResponse.json(response);
  }),

  http.get('/api/tasks/:id', ({ params }) => {
    const { id } = params;
    const task = MOCK_TASKS.find(t => t.id === Number(id));
    if (task) {
      return HttpResponse.json(task);
    } else {
      return new HttpResponse(null, { status: 404 });
    }
  }),

  http.post('/api/tasks', async ({ request }) => {
    const newTaskData = (await request.json()) as Partial<Task>;
    const newTask: Task = {
      id: MOCK_TASKS.length + 1,
      title: newTaskData.title || 'New Task',
      team_id: newTaskData.team_id || 1,
      git_url: newTaskData.git_url || '',
      git_repo: newTaskData.git_repo || '',
      git_repo_id: newTaskData.git_repo_id || 0,
      git_domain: newTaskData.git_domain || '',
      branch_name: newTaskData.branch_name || '',
      prompt: newTaskData.prompt || '',
      status: 'PENDING',
      task_type: newTaskData.task_type,
      progress: 0,
      batch: newTaskData.batch || 1,
      result: {},
      error_message: '',
      user_id: 1, // Mock user
      user_name: 'admin',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      completed_at: '',
    };
    MOCK_TASKS.push(newTask);
    return HttpResponse.json(newTask, { status: 201 });
  }),

  http.delete('/api/tasks/:id', ({ params }) => {
    const { id } = params;
    const index = MOCK_TASKS.findIndex(t => t.id === Number(id));
    if (index !== -1) {
      MOCK_TASKS.splice(index, 1);
      return HttpResponse.json({ message: 'Task deleted successfully' });
    } else {
      return new HttpResponse(null, { status: 404 });
    }
  }),
];
