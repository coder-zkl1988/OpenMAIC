'use client';

import { useId } from 'react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';

/**
 * Classroom preferences (系统设置 › 课堂): whether the teaching assistant
 * answers questions asked while the lecture plays, so the teacher keeps
 * lecturing instead of pausing at the end of the line; whether the teacher
 * may call on the learner by name (off by default); and whether a course
 * generated with its own classmates still uses the learner's preset ones.
 */
export function ClassroomSettings() {
  const { t } = useI18n();
  const id = useId();
  const assistantAnswers = useSettingsStore((s) => s.assistantAnswersDuringLecture);
  const setAssistantAnswers = useSettingsStore((s) => s.setAssistantAnswersDuringLecture);
  const teacherMayCall = useSettingsStore((s) => s.teacherMayCallOnLearner);
  const setTeacherMayCall = useSettingsStore((s) => s.setTeacherMayCallOnLearner);
  const presetInGeneratedCourses = useSettingsStore((s) => s.presetAgentsInGeneratedCourses);
  const setPresetInGeneratedCourses = useSettingsStore((s) => s.setPresetAgentsInGeneratedCourses);

  return (
    <section aria-labelledby={`${id}-title`} className="space-y-3">
      <h3 id={`${id}-title`} className="text-sm font-semibold">
        {t('settings.classroomSection')}
      </h3>
      <div className="flex items-start justify-between gap-4 rounded-xl border p-4">
        <div className="min-w-0 flex-1">
          <Label htmlFor={`${id}-assistant`} className="text-sm font-medium">
            {t('settings.assistantAnswersDuringLecture')}
          </Label>
          <p
            id={`${id}-assistant-desc`}
            className="mt-0.5 text-xs leading-relaxed text-muted-foreground"
          >
            {t('settings.assistantAnswersDuringLectureDesc')}
          </p>
        </div>
        <Switch
          id={`${id}-assistant`}
          data-testid="setting-assistant-answers-during-lecture"
          checked={assistantAnswers !== false}
          onCheckedChange={setAssistantAnswers}
          aria-describedby={`${id}-assistant-desc`}
          className="mt-0.5"
        />
      </div>
      <div className="flex items-start justify-between gap-4 rounded-xl border p-4">
        <div className="min-w-0 flex-1">
          <Label htmlFor={`${id}-call-on-me`} className="text-sm font-medium">
            {t('settings.teacherMayCallOnLearner')}
          </Label>
          <p
            id={`${id}-call-on-me-desc`}
            className="mt-0.5 text-xs leading-relaxed text-muted-foreground"
          >
            {t('settings.teacherMayCallOnLearnerDesc')}
          </p>
        </div>
        <Switch
          id={`${id}-call-on-me`}
          data-testid="setting-teacher-may-call-on-learner"
          checked={teacherMayCall === true}
          onCheckedChange={setTeacherMayCall}
          aria-describedby={`${id}-call-on-me-desc`}
          className="mt-0.5"
        />
      </div>
      <div className="flex items-start justify-between gap-4 rounded-xl border p-4">
        <div className="min-w-0 flex-1">
          <Label htmlFor={`${id}-preset`} className="text-sm font-medium">
            {t('settings.presetAgentsInGeneratedCourses')}
          </Label>
          <p
            id={`${id}-preset-desc`}
            className="mt-0.5 text-xs leading-relaxed text-muted-foreground"
          >
            {t('settings.presetAgentsInGeneratedCoursesDesc')}
          </p>
        </div>
        <Switch
          id={`${id}-preset`}
          data-testid="setting-preset-agents-in-generated-courses"
          checked={presetInGeneratedCourses === true}
          onCheckedChange={setPresetInGeneratedCourses}
          aria-describedby={`${id}-preset-desc`}
          className="mt-0.5"
        />
      </div>
    </section>
  );
}
