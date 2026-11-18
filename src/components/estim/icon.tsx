const paths: Record<string, string> = {
  "inbox": "<path d=\"M3 13l3-8h12l3 8v6H3z\"/><path d=\"M3 13h5l1.5 2.5h5L16 13h5\"/>",
  "mail": "<rect x=\"3\" y=\"5\" width=\"18\" height=\"14\" rx=\"3\"/><path d=\"M4 7l8 6 8-6\"/>",
  "chatt": "<path d=\"M4 5h16v11H11l-4 4v-4H4z\"/>",
  "wa": "<path d=\"M4 20l1.4-4A8 8 0 1 1 8.2 18.7z\"/><path d=\"M9.2 8.6c.2 2.4 2.6 4.9 5.2 5.3l1-1.1 1.8.9c-.3 1.2-1.3 1.7-2.4 1.6-3.2-.3-6-3.1-6.2-6.3 0-1.1.6-2 1.7-2.2l.8 1.8z\"/>",
  "form": "<rect x=\"5\" y=\"4\" width=\"14\" height=\"17\" rx=\"2.5\"/><path d=\"M9 3.5h6v3H9zM8.5 11h7M8.5 15h4.5\"/>",
  "offert": "<path d=\"M6 3h9l4 4v14H6z\"/><path d=\"M14 3v5h5M9 13h7M9 17h5\"/>",
  "settings": "<circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4L5.3 5.3\"/>",
  "plug": "<path d=\"M9 3v5M15 3v5M6 8h12v3a6 6 0 01-12 0zM12 17v4\"/>",
  "check": "<path d=\"M5 12.5l4.5 4.5L19 7.5\"/>",
  "x": "<path d=\"M6 6l12 12M18 6L6 18\"/>",
  "back": "<path d=\"M19 12H5M11 6l-6 6 6 6\"/>",
  "arrow": "<path d=\"M5 12h14M13 6l6 6-6 6\"/>",
  "send": "<path d=\"M21 3L3 10.5l7.5 3L14 21z\"/><path d=\"M10.5 13.5L21 3\"/>",
  "edit": "<path d=\"M4 20h4L19 9l-4-4L4 16z\"/><path d=\"M13.5 6.5l4 4\"/>",
  "eye": "<path d=\"M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/>",
  "spark": "<path d=\"M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z\"/><path d=\"M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z\"/>",
  "clip": "<path d=\"M20 11.5l-8.3 8.3a5 5 0 01-7-7L13 4.5a3.3 3.3 0 014.7 4.7l-8.3 8.3a1.7 1.7 0 01-2.4-2.4l7.6-7.6\"/>",
  "phone": "<path d=\"M6 3h3l2 5-2 1.5a11 11 0 006 6L16.5 13l5 2v3a3 3 0 01-3 3A16 16 0 013 6a3 3 0 013-3z\"/>",
  "mobile": "<rect x=\"7\" y=\"2.5\" width=\"10\" height=\"19\" rx=\"2.5\"/><path d=\"M11 18.5h2\"/>",
  "desk": "<rect x=\"3\" y=\"4\" width=\"18\" height=\"12\" rx=\"2\"/><path d=\"M8 20h8M12 16v4\"/>",
  "cal": "<rect x=\"3.5\" y=\"5\" width=\"17\" height=\"15\" rx=\"3\"/><path d=\"M3.5 10h17M8 3v4M16 3v4\"/>",
  "warn": "<path d=\"M12 4l9 16H3z\"/><path d=\"M12 10v4M12 17h.01\"/>",
  "info": "<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M12 11v6M12 7.5h.01\"/>",
  "play": "<path d=\"M7 5v14l12-7z\"/>",
  "plus": "<path d=\"M12 5v14M5 12h14\"/>",
  "trash": "<path d=\"M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13\"/>",
  "trygg": "<path d=\"M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z\"/><path d=\"M8.5 12l2.5 2.5 4.5-5\"/>",
  "tid": "<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M12 7v5l3.5 2\"/>",
  "user": "<circle cx=\"12\" cy=\"8\" r=\"4\"/><path d=\"M4 21a8 8 0 0116 0\"/>",
  "doc": "<path d=\"M7 3h7l5 5v13H7z\"/><path d=\"M14 3v5h5\"/>",
  "foto": "<rect x=\"3\" y=\"6\" width=\"18\" height=\"14\" rx=\"3\"/><circle cx=\"12\" cy=\"13\" r=\"3.5\"/><path d=\"M8 6l1.5-2.5h5L16 6\"/>",
  "bolt": "<path d=\"M13 3L5 13h6l-1 8 8-10h-6z\"/>",
  "lock": "<rect x=\"5\" y=\"11\" width=\"14\" height=\"10\" rx=\"3\"/><path d=\"M8 11V8a4 4 0 018 0v3\"/>",
  "search": "<circle cx=\"11\" cy=\"11\" r=\"7\"/><path d=\"M20 20l-4-4\"/>",
  "copy": "<rect x=\"8\" y=\"8\" width=\"12\" height=\"12\" rx=\"3\"/><path d=\"M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3\"/>"
};

// Original prototype icon paths preserve the reference artwork.
export function Icon({ name }: { name: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: paths[name] ?? "" }} />;
}
