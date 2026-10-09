import React, { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { ExamApi } from '../exam/api.js';
import { companionUrl } from './companionUrl.js';

export interface PhoneEnrollmentModalProps {
  readonly attemptId: string;
  readonly examApi: ExamApi;
  readonly onClose: () => void;
}

export function PhoneEnrollmentModal({
  attemptId,
  examApi,
  onClose,
}: PhoneEnrollmentModalProps): React.ReactElement {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [base, setBase] = useState('');
  let qrUrl: string | null = null;
  if (token && base) {
    try {
      qrUrl = companionUrl(base, token, attemptId);
    } catch {
      /* Show guidance until the origin is valid. */
    }
  }

  useEffect(() => {
    examApi
      .postEnrollPhone(attemptId)
      .then((res) => {
        setToken(res.token);
      })
      .catch((err) => {
        setError(err.message || 'Failed to get enrollment token');
      });
  }, [attemptId, examApi]);

  useEffect(() => {
    if (!token) return;
    const interval = setInterval(() => {
      examApi
        .getPhoneStatus(attemptId)
        .then((res) => {
          if (res && res.active) {
            onClose();
          }
        })
        .catch(() => {});
    }, 2000);
    return () => clearInterval(interval);
  }, [token, attemptId, examApi, onClose]);

  return (
    <div
      className="enroll-modal"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.85)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10000,
        backdropFilter: 'blur(10px)',
      }}
    >
      <div
        className="enroll-modal-content"
        style={{
          backgroundColor: '#18181b',
          padding: '3rem',
          borderRadius: '16px',
          textAlign: 'center',
          color: '#fff',
          border: '1px solid #3f3f46',
          maxWidth: '450px',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
        }}
      >
        <h2 style={{ fontSize: '1.5rem', marginBottom: '0.5rem', fontWeight: 600 }}>
          Connect companion phone
        </h2>
        <p style={{ color: '#a1a1aa', marginBottom: '2rem', fontSize: '0.95rem', lineHeight: 1.5 }}>
          Enter the laptop’s reachable address. The phone cannot connect to the laptop through
          localhost or 127.0.0.1.
        </p>
        <label>
          Laptop origin{' '}
          <input
            value={base}
            onChange={(event) => setBase(event.target.value)}
            placeholder="http://192.168.1.10:5173"
          />
        </label>
        <p>
          Same trusted Wi-Fi: enable LAN mode first. HTTP supports enrollment/heartbeat only; phone
          microphone access requires trusted HTTPS. The QR contains a private enrollment token—do
          not share it.
        </p>
        <button type="button" onClick={onClose}>
          Close setup
        </button>

        {error ? (
          <div
            style={{
              background: '#7f1d1d',
              padding: '1rem',
              borderRadius: '8px',
              color: '#fca5a5',
            }}
          >
            <strong>Connection Error</strong>
            <p>{error}</p>
          </div>
        ) : token ? (
          <>
            <div
              style={{
                background: '#fff',
                padding: '1rem',
                borderRadius: '12px',
                display: 'inline-block',
                boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
              }}
            >
              {qrUrl ? (
                <QRCodeSVG value={qrUrl} size={220} />
              ) : (
                <p style={{ color: '#111' }}>
                  Enter a valid phone-reachable origin to generate the QR.
                </p>
              )}
            </div>

            <div
              style={{
                marginTop: '2rem',
                textAlign: 'left',
                background: '#27272a',
                padding: '1.25rem',
                borderRadius: '8px',
              }}
            >
              <h3
                style={{
                  fontSize: '0.9rem',
                  color: '#e4e4e7',
                  marginBottom: '0.75rem',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                Setup Instructions:
              </h3>
              <ol
                style={{
                  color: '#a1a1aa',
                  fontSize: '0.9rem',
                  margin: 0,
                  paddingLeft: '1.25rem',
                  lineHeight: 1.6,
                }}
              >
                <li>Open your phone's Camera app</li>
                <li>Scan the QR code above</li>
                <li>
                  Check the phone reports “Connected”. Camera recording is not implemented on this
                  companion page.
                </li>
              </ol>
            </div>
          </>
        ) : (
          <div style={{ padding: '4rem 0', color: '#71717a' }}>
            <div
              className="spinner"
              style={{
                margin: '0 auto 1rem',
                width: '30px',
                height: '30px',
                border: '3px solid #3f3f46',
                borderTopColor: '#3b82f6',
                borderRadius: '50%',
                animation: 'spin 1s linear infinite',
              }}
            />
            Generating secure token...
          </div>
        )}

        <style
          dangerouslySetInnerHTML={{
            __html: `
          @keyframes spin { to { transform: rotate(360deg); } }
        `,
          }}
        />
      </div>
    </div>
  );
}
