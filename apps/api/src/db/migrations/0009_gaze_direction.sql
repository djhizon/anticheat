-- Gaze events gain a coarse direction so the unified integrity log can say
-- "looked left" or "no face in view" instead of only "off screen".
-- Values: left | right | up | down | away | no_face | multiple_faces.
-- yaw/pitch are rounded head-pose degrees (camera-relative), never images.
ALTER TABLE gaze_events ADD COLUMN direction TEXT NOT NULL DEFAULT 'away';
ALTER TABLE gaze_events ADD COLUMN yaw REAL;
ALTER TABLE gaze_events ADD COLUMN pitch REAL;
