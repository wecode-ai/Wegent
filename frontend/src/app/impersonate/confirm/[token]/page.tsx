// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tag } from '@/components/ui/tag';
import { impersonationApis } from '@/apis/impersonation';
import { userApis } from '@/apis/user';
import { ImpersonationConfirmInfo, ImpersonationStatus } from '@/types/impersonation';
import { useToast } from '@/hooks/use-toast';
import {
  ShieldExclamationIcon,
  CheckCircleIcon,
  XCircleIcon,
  ClockIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import { Loader2 } from 'lucide-react';

export default function ImpersonationConfirmPage() {
  const params = useParams();
  const router = useRouter();
  const { toast } = useToast();
  const token = params.token as string;

  const [info, setInfo] = useState<ImpersonationConfirmInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [remainingTime, setRemainingTime] = useState<string>('');
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  // Check if user is authenticated
  useEffect(() => {
    const checkAuth = () => {
      const authenticated = userApis.isAuthenticated();
      setIsAuthenticated(authenticated);
    };
    checkAuth();
  }, []);

  // Fetch request info
  useEffect(() => {
    const fetchInfo = async () => {
      try {
        const data = await impersonationApis.getConfirmInfo(token);
        setInfo(data);
      } catch (error) {
        toast({
          variant: 'destructive',
          title: 'Failed to load request',
          description: (error as Error).message,
        });
      } finally {
        setLoading(false);
      }
    };

    if (token) {
      fetchInfo();
    }
  }, [token, toast]);

  // Update remaining time countdown
  useEffect(() => {
    if (!info || info.status !== 'pending') return;

    const updateRemainingTime = () => {
      const now = new Date();
      const expiresAt = new Date(info.expires_at);
      const diff = expiresAt.getTime() - now.getTime();

      if (diff <= 0) {
        setRemainingTime('Expired');
        return;
      }

      const minutes = Math.floor(diff / (1000 * 60));
      const seconds = Math.floor((diff % (1000 * 60)) / 1000);

      setRemainingTime(`${minutes}m ${seconds}s`);
    };

    updateRemainingTime();
    const interval = setInterval(updateRemainingTime, 1000);

    return () => clearInterval(interval);
  }, [info]);

  const handleApprove = async () => {
    if (!isAuthenticated) {
      // Redirect to login with return URL
      const returnUrl = encodeURIComponent(window.location.pathname);
      router.push(`/login?redirect=${returnUrl}`);
      return;
    }

    setProcessing(true);
    try {
      const updatedInfo = await impersonationApis.approveRequest(token);
      setInfo(updatedInfo);
      toast({
        title: 'Request approved',
        description: 'The admin can now impersonate your account.',
      });
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Failed to approve request',
        description: (error as Error).message,
      });
    } finally {
      setProcessing(false);
    }
  };

  const handleReject = async () => {
    if (!isAuthenticated) {
      // Redirect to login with return URL
      const returnUrl = encodeURIComponent(window.location.pathname);
      router.push(`/login?redirect=${returnUrl}`);
      return;
    }

    setProcessing(true);
    try {
      const updatedInfo = await impersonationApis.rejectRequest(token);
      setInfo(updatedInfo);
      toast({
        title: 'Request rejected',
        description: 'The impersonation request has been declined.',
      });
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Failed to reject request',
        description: (error as Error).message,
      });
    } finally {
      setProcessing(false);
    }
  };

  const getStatusConfig = (status: ImpersonationStatus) => {
    const configs: Record<
      ImpersonationStatus,
      { icon: React.ReactNode; color: string; bgColor: string; label: string }
    > = {
      pending: {
        icon: <ClockIcon className="w-12 h-12" />,
        color: 'text-amber-600',
        bgColor: 'bg-amber-50',
        label: 'Pending Approval',
      },
      approved: {
        icon: <CheckCircleIcon className="w-12 h-12" />,
        color: 'text-green-600',
        bgColor: 'bg-green-50',
        label: 'Approved',
      },
      rejected: {
        icon: <XCircleIcon className="w-12 h-12" />,
        color: 'text-red-600',
        bgColor: 'bg-red-50',
        label: 'Rejected',
      },
      expired: {
        icon: <ExclamationTriangleIcon className="w-12 h-12" />,
        color: 'text-gray-600',
        bgColor: 'bg-gray-50',
        label: 'Expired',
      },
      used: {
        icon: <CheckCircleIcon className="w-12 h-12" />,
        color: 'text-blue-600',
        bgColor: 'bg-blue-50',
        label: 'Used',
      },
    };
    return configs[status];
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-base">
        <Loader2 className="w-8 h-8 animate-spin text-text-muted" />
      </div>
    );
  }

  if (!info) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-base">
        <Card className="p-8 max-w-md text-center">
          <XCircleIcon className="w-12 h-12 text-error mx-auto mb-4" />
          <h1 className="text-xl font-semibold mb-2">Request Not Found</h1>
          <p className="text-text-muted">
            This impersonation request does not exist or has been removed.
          </p>
        </Card>
      </div>
    );
  }

  const statusConfig = getStatusConfig(info.status);

  return (
    <div className="min-h-screen flex items-center justify-center bg-base p-4">
      <Card className="p-8 max-w-lg w-full">
        {/* Header */}
        <div className="text-center mb-6">
          <div
            className={`w-20 h-20 rounded-full ${statusConfig.bgColor} ${statusConfig.color} mx-auto flex items-center justify-center mb-4`}
          >
            {statusConfig.icon}
          </div>
          <h1 className="text-2xl font-semibold mb-2">Impersonation Request</h1>
          <Tag
            variant={
              info.status === 'approved'
                ? 'success'
                : info.status === 'rejected'
                  ? 'error'
                  : info.status === 'pending'
                    ? 'warning'
                    : 'default'
            }
          >
            {statusConfig.label}
          </Tag>
        </div>

        {/* Info */}
        <div className="space-y-4 mb-6">
          <div className="flex items-center justify-between p-3 bg-muted rounded-lg">
            <span className="text-sm text-text-muted">Admin</span>
            <span className="font-medium">{info.admin_user_name}</span>
          </div>
          <div className="flex items-center justify-between p-3 bg-muted rounded-lg">
            <span className="text-sm text-text-muted">Target User</span>
            <span className="font-medium">{info.target_user_name}</span>
          </div>
          {info.status === 'pending' && (
            <div className="flex items-center justify-between p-3 bg-muted rounded-lg">
              <span className="text-sm text-text-muted">Expires In</span>
              <span className="font-mono font-medium">{remainingTime}</span>
            </div>
          )}
          <div className="flex items-center justify-between p-3 bg-muted rounded-lg">
            <span className="text-sm text-text-muted">Requested At</span>
            <span className="font-medium">
              {new Date(info.created_at).toLocaleString()}
            </span>
          </div>
        </div>

        {/* Warning */}
        {info.status === 'pending' && (
          <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg mb-6">
            <div className="flex items-start gap-3">
              <ShieldExclamationIcon className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-amber-800">
                <p className="font-medium mb-1">Security Notice</p>
                <p>
                  By approving this request, you allow the admin to access your account
                  and perform actions on your behalf. The session will be limited to 24 hours
                  and all actions will be logged.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Not Authenticated Warning */}
        {info.status === 'pending' && !isAuthenticated && (
          <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg mb-6">
            <p className="text-sm text-blue-800">
              You need to log in as <strong>{info.target_user_name}</strong> to approve or reject this request.
            </p>
          </div>
        )}

        {/* Actions */}
        {info.status === 'pending' && (
          <div className="flex gap-3">
            <Button
              variant="outline"
              className="flex-1"
              onClick={handleReject}
              disabled={processing}
            >
              {processing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Reject
            </Button>
            <Button className="flex-1" onClick={handleApprove} disabled={processing}>
              {processing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Approve
            </Button>
          </div>
        )}

        {/* Status Messages */}
        {info.status === 'approved' && (
          <div className="p-4 bg-green-50 border border-green-200 rounded-lg text-center">
            <p className="text-green-800">
              This request has been approved. The admin can now access your account.
            </p>
          </div>
        )}

        {info.status === 'rejected' && (
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-center">
            <p className="text-red-800">This request has been rejected.</p>
          </div>
        )}

        {info.status === 'expired' && (
          <div className="p-4 bg-gray-100 border border-gray-200 rounded-lg text-center">
            <p className="text-gray-600">This request has expired.</p>
          </div>
        )}

        {info.status === 'used' && (
          <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg text-center">
            <p className="text-blue-800">
              This request has been used. The impersonation session may be active.
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
