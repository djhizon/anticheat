import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StudentExamPage } from './StudentExamPage.js';

describe('exam screen crash regression', () => {
  it('renders while an assignment is loading without referencing missing state', () => {
    const html = renderToString(
      <StudentExamPage delivery={null} error={null} loading={true} onBack={() => {}} />,
    );
    expect(html).toContain('Loading');
  });

  it('renders a recoverable failed request', () => {
    const html = renderToString(
      <StudentExamPage delivery={null} error="Exam unavailable" loading={false} onBack={() => {}} />,
    );
    expect(html).toContain('Exam unavailable');
    expect(html).toContain('Back to assignments');
  });
});
