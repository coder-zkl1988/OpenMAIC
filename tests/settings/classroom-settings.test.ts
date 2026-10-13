// @vitest-environment jsdom
/**
 * 系统设置 › 课堂: the switch for 讲课时由助教回答提问 reads and writes the
 * `assistantAnswersDuringLecture` preference; 始终使用我的预设同学 reads and
 * writes `presetAgentsInGeneratedCourses`.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({
  assistantAnswersDuringLecture: true,
  setAssistantAnswersDuringLecture: vi.fn(),
  presetAgentsInGeneratedCourses: false,
  setPresetAgentsInGeneratedCourses: vi.fn(),
  teacherMayCallOnLearner: false,
  setTeacherMayCallOnLearner: vi.fn(),
}));
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: (selector: (state: typeof settings) => unknown) => selector(settings),
}));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

import { ClassroomSettings } from '@/components/settings/classroom-settings';

describe('ClassroomSettings', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    settings.assistantAnswersDuringLecture = true;
    settings.setAssistantAnswersDuringLecture.mockReset();
    settings.presetAgentsInGeneratedCourses = false;
    settings.setPresetAgentsInGeneratedCourses.mockReset();
    settings.teacherMayCallOnLearner = false;
    settings.setTeacherMayCallOnLearner.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const toggle = () =>
    container.querySelector(
      '[data-testid="setting-assistant-answers-during-lecture"]',
    ) as HTMLButtonElement;

  it('labels and describes the switch, and turns the preference off and on', () => {
    act(() => root.render(createElement(ClassroomSettings)));
    expect(container.textContent).toContain('settings.classroomSection');
    expect(container.textContent).toContain('settings.assistantAnswersDuringLecture');
    expect(container.textContent).toContain('settings.assistantAnswersDuringLectureDesc');
    expect(toggle().getAttribute('role')).toBe('switch');
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    // The label names the switch, the description describes it
    const label = container.querySelector(`label[for="${toggle().id}"]`);
    expect(label?.textContent).toBe('settings.assistantAnswersDuringLecture');
    const description = document.getElementById(toggle().getAttribute('aria-describedby')!);
    expect(description?.textContent).toBe('settings.assistantAnswersDuringLectureDesc');

    act(() => toggle().click());
    expect(settings.setAssistantAnswersDuringLecture).toHaveBeenCalledExactlyOnceWith(false);

    settings.assistantAnswersDuringLecture = false;
    act(() => root.render(createElement(ClassroomSettings)));
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    act(() => toggle().click());
    expect(settings.setAssistantAnswersDuringLecture).toHaveBeenLastCalledWith(true);
  });

  it('turns "always use my preset classmates" on and off (off by default)', () => {
    const presetToggle = () =>
      container.querySelector(
        '[data-testid="setting-preset-agents-in-generated-courses"]',
      ) as HTMLButtonElement;
    act(() => root.render(createElement(ClassroomSettings)));
    expect(container.textContent).toContain('settings.presetAgentsInGeneratedCourses');
    expect(presetToggle().getAttribute('aria-checked')).toBe('false');
    const description = document.getElementById(presetToggle().getAttribute('aria-describedby')!);
    expect(description?.textContent).toBe('settings.presetAgentsInGeneratedCoursesDesc');

    act(() => presetToggle().click());
    expect(settings.setPresetAgentsInGeneratedCourses).toHaveBeenCalledExactlyOnceWith(true);

    settings.presetAgentsInGeneratedCourses = true;
    act(() => root.render(createElement(ClassroomSettings)));
    expect(presetToggle().getAttribute('aria-checked')).toBe('true');
    act(() => presetToggle().click());
    expect(settings.setPresetAgentsInGeneratedCourses).toHaveBeenLastCalledWith(false);
  });

  it('turns "let the teacher call on me" on and off (off by default)', () => {
    const callToggle = () =>
      container.querySelector(
        '[data-testid="setting-teacher-may-call-on-learner"]',
      ) as HTMLButtonElement;
    act(() => root.render(createElement(ClassroomSettings)));
    expect(container.textContent).toContain('settings.teacherMayCallOnLearner');
    expect(callToggle().getAttribute('aria-checked')).toBe('false');
    const description = document.getElementById(callToggle().getAttribute('aria-describedby')!);
    expect(description?.textContent).toBe('settings.teacherMayCallOnLearnerDesc');

    act(() => callToggle().click());
    expect(settings.setTeacherMayCallOnLearner).toHaveBeenCalledExactlyOnceWith(true);

    settings.teacherMayCallOnLearner = true;
    act(() => root.render(createElement(ClassroomSettings)));
    expect(callToggle().getAttribute('aria-checked')).toBe('true');
    act(() => callToggle().click());
    expect(settings.setTeacherMayCallOnLearner).toHaveBeenLastCalledWith(false);
  });
});
