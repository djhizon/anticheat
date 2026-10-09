import { useEffect, useState } from 'react';
import type { SimilarityReportResponse } from '@exam-anti-cheat/contracts/exam';

export function SimilarityDashboard({ examId }: { readonly examId: string }) {
  const [reports, setReports] = useState<SimilarityReportResponse[]>([]);
  const [loading, setLoading] = useState(true);

  // Note: in a real app, this would hit an actual endpoint like `/admin/exams/:id/similarity`
  // that runs the k-means clustering or returns pre-computed pairs.
  // We'll simulate fetching for the sake of the dashboard scaffold.
  useEffect(() => {
    // Fake fetch
    setTimeout(() => {
      setReports([
        {
          questionId: 'q-123',
          threshold: 0.9,
          generatedAt: new Date().toISOString(),
          pairs: [
            { studentAId: 'user-001', studentBId: 'user-004', score: 0.95, flagged: true },
            { studentAId: 'user-007', studentBId: 'user-012', score: 0.92, flagged: true },
          ],
        },
      ]);
      setLoading(false);
    }, 1000);
  }, [examId]);

  if (loading) return <div className="admin-loading">Running Gemini K-Means Clustering...</div>;

  return (
    <div className="admin-dashboard">
      <h2>🤝 Cross-Student Similarity Clusters</h2>
      <p>Using Gemini Embeddings to cluster suspiciously similar subjective answers.</p>
      
      {reports.length === 0 ? (
        <p>No collusion detected.</p>
      ) : (
        reports.map((report) => (
          <div key={report.questionId} className="similarity-card">
            <h3>Question {report.questionId} (Threshold: {report.threshold})</h3>
            <span className="similarity-meta">Generated: {new Date(report.generatedAt).toLocaleString()}</span>
            
            <ul className="similarity-list">
              {report.pairs.map((pair, idx) => (
                <li key={idx} className={pair.flagged ? 'flagged-pair' : ''}>
                  <div className="pair-ids">
                    Student A (ID: {pair.studentAId}) ↔ Student B (ID: {pair.studentBId})
                  </div>
                  <div className="pair-score">
                    Similarity Score: {(pair.score * 100).toFixed(1)}%
                  </div>
                  {pair.flagged && <span className="collusion-warning">⚠️ Highly Suspicious</span>}
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </div>
  );
}
