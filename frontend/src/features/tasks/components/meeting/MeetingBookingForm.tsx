// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState, useMemo, useContext } from 'react';
import { Calendar, Clock, MapPin, Users, Send, Code, FileText, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import type { MeetingBookingFormData, CreateMeetingRequest } from '@/types/api';
import { useTranslation } from '@/hooks/useTranslation';
import { TaskContext } from '../../contexts/taskContext';
import { ChatStreamContext } from '../../contexts/chatStreamContext';
import { useToast } from '@/hooks/use-toast';
import { createMeeting } from '@/apis/meeting';

interface MeetingBookingFormProps {
  data: MeetingBookingFormData;
  taskId: number;
  currentMessageIndex: number;
  /** Raw markdown content for display when toggling to raw view */
  rawContent?: string;
  /** Callback when user submits the booking result, passes the formatted markdown result */
  onSubmit?: (formattedResult: string) => void;
}

export default function MeetingBookingForm({
  data,
  taskId,
  currentMessageIndex,
  rawContent,
  onSubmit,
}: MeetingBookingFormProps) {
  const { t } = useTranslation('chat');
  const { toast } = useToast();

  // Use context directly - it will be undefined if not within TaskContextProvider
  const taskContext = useContext(TaskContext);
  const selectedTaskDetail = taskContext?.selectedTaskDetail ?? null;

  // Get isTaskStreaming from ChatStreamContext
  const chatStreamContext = useContext(ChatStreamContext);
  const isTaskStreaming = chatStreamContext?.isTaskStreaming ?? null;

  // Form state
  const [title, setTitle] = useState(data.title);
  const [startTime, setStartTime] = useState(data.startTime);
  const [endTime, setEndTime] = useState(data.endTime);
  const [selectedRoomId, setSelectedRoomId] = useState(data.roomId);
  const [selectedParticipantIds, setSelectedParticipantIds] = useState<string[]>(
    data.participantIds || []
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showRawContent, setShowRawContent] = useState(false);

  // Check if this booking form has been submitted
  const isSubmitted = useMemo(() => {
    if (!selectedTaskDetail?.subtasks || selectedTaskDetail.subtasks.length === 0) return false;

    // Check if there's any USER message after the current message index
    const subtasksAfter = selectedTaskDetail.subtasks.slice(currentMessageIndex + 1);
    return subtasksAfter.some((sub: { role: string }) => sub.role === 'USER');
  }, [selectedTaskDetail?.subtasks, currentMessageIndex]);

  // Handle participant selection toggle
  const handleParticipantToggle = (participantId: string, checked: boolean) => {
    if (isSubmitted || isSubmitting) return;

    setSelectedParticipantIds(prev =>
      checked ? [...prev, participantId] : prev.filter(id => id !== participantId)
    );
  };

  // Format datetime for display
  const formatDateTimeForDisplay = (isoString: string) => {
    try {
      const date = new Date(isoString);
      return date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return isoString;
    }
  };

  // Handle booking submission
  const handleSubmit = async () => {
    if (isSubmitted || isSubmitting) return;

    // Validation
    if (!title.trim()) {
      toast({
        variant: 'destructive',
        title: t('meeting.validation_error') || 'Validation Error',
        description: t('meeting.title_required') || 'Meeting title is required',
      });
      return;
    }

    if (!selectedRoomId) {
      toast({
        variant: 'destructive',
        title: t('meeting.validation_error') || 'Validation Error',
        description: t('meeting.room_required') || 'Please select a meeting room',
      });
      return;
    }

    setIsSubmitting(true);

    try {
      // Build the request
      const request: CreateMeetingRequest = {
        title: title.trim(),
        start_time: startTime,
        end_time: endTime,
        room_id: selectedRoomId,
        participant_ids: selectedParticipantIds,
      };

      // Call the remote meeting API directly
      const result = await createMeeting(request);

      // Format result as markdown message
      let resultMessage: string;
      if (result.success) {
        const selectedRoom = data.availableRooms?.find(r => r.id === selectedRoomId);
        const selectedParticipants = data.availableParticipants
          ?.filter(p => selectedParticipantIds.includes(p.id))
          .map(p => p.name)
          .join('、');

        resultMessage = `## ✅ 会议预约成功 (Meeting Booked Successfully)\n\n`;
        resultMessage += `**会议ID**: ${result.meetingId || 'N/A'}\n`;
        resultMessage += `**会议名称**: ${title}\n`;
        resultMessage += `**会议时间**: ${formatDateTimeForDisplay(startTime)} - ${formatDateTimeForDisplay(endTime)}\n`;
        resultMessage += `**会议地点**: ${selectedRoom?.name || selectedRoomId}\n`;
        if (selectedParticipants) {
          resultMessage += `**参会人员**: ${selectedParticipants}\n`;
        }
        if (result.message) {
          resultMessage += `\n${result.message}`;
        }
      } else {
        resultMessage = `## ❌ 会议预约失败 (Meeting Booking Failed)\n\n`;
        resultMessage += `**错误信息**: ${result.error || 'Unknown error'}\n`;
        resultMessage += `\n请检查会议室是否可用，或尝试选择其他时间段。`;
      }

      // Send result to AI via the callback
      if (onSubmit) {
        onSubmit(resultMessage);
      }

      if (result.success) {
        toast({
          title: t('meeting.booking_success') || 'Meeting Booked',
          description:
            t('meeting.booking_success_desc') || 'Your meeting has been booked successfully',
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const resultMessage = `## ❌ 会议预约失败 (Meeting Booking Failed)\n\n**错误信息**: ${errorMessage}\n\n请稍后重试或联系管理员。`;

      if (onSubmit) {
        onSubmit(resultMessage);
      }

      toast({
        variant: 'destructive',
        title: t('meeting.booking_failed') || 'Booking Failed',
        description: errorMessage,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-4 p-4 rounded-lg border border-primary/30 bg-primary/5">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Calendar className="w-5 h-5 text-primary" />
          <h3 className="text-base font-semibold text-primary">
            {t('meeting.title') || 'Meeting Booking Confirmation'}
          </h3>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowRawContent(!showRawContent)}
          className="text-xs text-text-secondary hover:text-text-primary"
        >
          {showRawContent ? (
            <>
              <FileText className="w-3.5 h-3.5 mr-1.5" />
              {t('meeting.show_form') || 'Show Form'}
            </>
          ) : (
            <>
              <Code className="w-3.5 h-3.5 mr-1.5" />
              {t('meeting.show_raw') || 'Show Raw'}
            </>
          )}
        </Button>
      </div>

      {showRawContent ? (
        <div className="p-3 rounded bg-surface/50 border border-border">
          <pre className="text-xs text-text-secondary overflow-auto max-h-96 whitespace-pre-wrap break-words font-mono">
            {rawContent || JSON.stringify(data, null, 2)}
          </pre>
        </div>
      ) : (
        <>
          {/* Meeting Title */}
          <div className="p-3 rounded bg-surface/50 border border-border">
            <div className="flex items-center gap-2 mb-2">
              <FileText className="w-4 h-4 text-text-secondary" />
              <Label className="text-sm font-medium text-text-primary">
                {t('meeting.meeting_title') || 'Meeting Title'}
              </Label>
            </div>
            <Input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder={t('meeting.title_placeholder') || 'Enter meeting title...'}
              disabled={isSubmitted || isSubmitting}
              className="w-full"
            />
          </div>

          {/* Meeting Time */}
          <div className="p-3 rounded bg-surface/50 border border-border">
            <div className="flex items-center gap-2 mb-2">
              <Clock className="w-4 h-4 text-text-secondary" />
              <Label className="text-sm font-medium text-text-primary">
                {t('meeting.meeting_time') || 'Meeting Time'}
              </Label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-text-muted">
                  {t('meeting.start_time') || 'Start'}
                </Label>
                <Input
                  type="datetime-local"
                  value={startTime.slice(0, 16)}
                  onChange={e => setStartTime(e.target.value + ':00')}
                  disabled={isSubmitted || isSubmitting}
                  className="w-full mt-1"
                />
              </div>
              <div>
                <Label className="text-xs text-text-muted">{t('meeting.end_time') || 'End'}</Label>
                <Input
                  type="datetime-local"
                  value={endTime.slice(0, 16)}
                  onChange={e => setEndTime(e.target.value + ':00')}
                  disabled={isSubmitted || isSubmitting}
                  className="w-full mt-1"
                />
              </div>
            </div>
            <div className="mt-2 text-xs text-text-muted">
              {t('meeting.duration') || 'Duration'}: {data.duration}{' '}
              {t('meeting.minutes') || 'minutes'}
            </div>
          </div>

          {/* Meeting Room Selection */}
          {data.availableRooms && data.availableRooms.length > 0 && (
            <div className="p-3 rounded bg-surface/50 border border-border">
              <div className="flex items-center gap-2 mb-2">
                <MapPin className="w-4 h-4 text-text-secondary" />
                <Label className="text-sm font-medium text-text-primary">
                  {t('meeting.meeting_location') || 'Meeting Location'}
                </Label>
              </div>
              <RadioGroup
                value={selectedRoomId}
                onValueChange={setSelectedRoomId}
                disabled={isSubmitted || isSubmitting}
                className="space-y-2"
              >
                {data.availableRooms.map(room => (
                  <div key={room.id} className="flex items-center space-x-2">
                    <RadioGroupItem value={room.id} id={`room-${room.id}`} />
                    <Label
                      htmlFor={`room-${room.id}`}
                      className="text-sm cursor-pointer flex items-center gap-2"
                    >
                      {room.name}
                      {room.recommended && (
                        <span className="px-1.5 py-0.5 text-xs bg-primary/20 text-primary rounded">
                          {t('meeting.recommended') || 'Recommended'}
                        </span>
                      )}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            </div>
          )}

          {/* Participants Selection */}
          {data.availableParticipants && data.availableParticipants.length > 0 && (
            <div className="p-3 rounded bg-surface/50 border border-border">
              <div className="flex items-center gap-2 mb-2">
                <Users className="w-4 h-4 text-text-secondary" />
                <Label className="text-sm font-medium text-text-primary">
                  {t('meeting.participants') || 'Participants'}
                </Label>
              </div>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {data.availableParticipants.map(participant => (
                  <div key={participant.id} className="flex items-center space-x-2">
                    <Checkbox
                      id={`participant-${participant.id}`}
                      checked={selectedParticipantIds.includes(participant.id)}
                      onCheckedChange={checked =>
                        handleParticipantToggle(participant.id, checked as boolean)
                      }
                      disabled={isSubmitted || isSubmitting}
                    />
                    <Label
                      htmlFor={`participant-${participant.id}`}
                      className="text-sm cursor-pointer flex items-center gap-2"
                    >
                      {participant.name}
                      {participant.recommended && (
                        <span className="px-1.5 py-0.5 text-xs bg-primary/20 text-primary rounded">
                          {t('meeting.recommended') || 'Recommended'}
                        </span>
                      )}
                    </Label>
                  </div>
                ))}
              </div>
              {selectedParticipantIds.length > 0 && (
                <div className="mt-2 text-xs text-text-muted">
                  {t('meeting.selected_count', { count: selectedParticipantIds.length }) ||
                    `${selectedParticipantIds.length} selected`}
                </div>
              )}
            </div>
          )}

          {/* Submit Button */}
          {!isSubmitted && !(isTaskStreaming && isTaskStreaming(taskId)) && (
            <div className="flex justify-end pt-2">
              <Button variant="secondary" onClick={handleSubmit} size="lg" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    {t('meeting.booking') || 'Booking...'}
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4 mr-2" />
                    {t('meeting.confirm_booking') || 'Confirm Booking'}
                  </>
                )}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
