import type { DatabaseSync } from 'node:sqlite';

import { SystemClock, type Clock } from '@examguard/contracts';

import type { ApiConfig } from '../../config.js';
import type { AuthRequestBoundary } from '../auth/auth.plugin.js';
import { SecureTokenGenerator, type TokenGenerator } from '../auth/session.js';
import { GeminiRotatingClient } from '../integrity/gemini.js';
import { IntegrityRepository } from '../integrity/integrityRepository.js';
import { IntegrityService } from '../integrity/integrityService.js';
import { detectObjectsRemotely } from '../integrity/backendVision.js';
import { deleteRecordingSegments, isRecordingUploadConfigured } from '../integrity/graph.js';
import { ExamRepository } from './exam.repository.js';
import { ExamRoutes } from './exam.routes.js';
import { ExamService } from './exam.service.js';
import { ReviewRepository } from './reviewRepository.js';
import { PhonePresenceService } from '../integrity/phonePresence.js';

export interface ExamPluginDependencies {
  readonly clock?: Clock;
  readonly idGenerator?: TokenGenerator;
}

export interface ExamPlugin {
  readonly repository: ExamRepository;
  readonly service: ExamService;
  readonly routes: ExamRoutes;
  readonly integrity: IntegrityService | null;
  readonly phonePresence: PhonePresenceService;
}

export function createExamPlugin(
  database: DatabaseSync,
  boundary: AuthRequestBoundary,
  config: ApiConfig,
  dependencies: ExamPluginDependencies = {},
): ExamPlugin {
  const repository = new ExamRepository(database);
  const phonePresence = new PhonePresenceService(database, dependencies.clock ?? new SystemClock());
  const service = new ExamService({
    repository,
    clock: dependencies.clock ?? new SystemClock(),
    idGenerator: dependencies.idGenerator ?? new SecureTokenGenerator(),
    privacyDefaults: {
      audioRetainDays: config.audioRetainDays,
      evidenceRetainDays: config.evidenceRetainDays,
      recordingUpload: config.recordingUploadDefault,
    },
    // Phone loss never blocks answering: the student UI shows a banner and the loss is logged.
  });

  // Integrity monitoring always runs; Gemini only powers the AI-backed checks.
  let gemini: GeminiRotatingClient | null = null;
  if (config.geminiKeys.length > 0) {
    // Keys 0-4 → question generation  |  Keys 5-9 → AI-check & liveness
    // If fewer than 6 keys, share all keys across both pools.
    const allKeys = config.geminiKeys;
    const aiCheckKeys = allKeys.length >= 6 ? allKeys.slice(5) : allKeys;
    gemini = new GeminiRotatingClient({
      keys: aiCheckKeys,
      model: config.geminiModel,
      embeddingModel: config.geminiEmbeddingModel,
    });
    console.log(
      `[exam-plugin] Gemini ready — ${aiCheckKeys.length} key(s) for AI-check/liveness, ` +
        `${Math.min(5, allKeys.length)} key(s) for question generation`,
    );
  } else {
    console.warn(
      '[exam-plugin] No GEMINI_API_KEYS configured — AI checks disabled; integrity monitoring and native phone presence remain available.',
    );
  }
  const integrity: IntegrityService | null = new IntegrityService(
    new IntegrityRepository(database),
    gemini,
    undefined,
    config.audioRetainDays,
    config.evidenceRetainDays,
    config.recordingUploadDefault,
    isRecordingUploadConfigured(config)
      ? (segments) => deleteRecordingSegments(config, segments).then(() => undefined)
      : null,
  );

  const routes = new ExamRoutes(
    service,
    boundary,
    config,
    integrity,
    phonePresence,
    config.backendVisionEnabled ? detectObjectsRemotely : null,
    new ReviewRepository(database),
  );

  return { repository, service, routes, integrity, phonePresence };
}
