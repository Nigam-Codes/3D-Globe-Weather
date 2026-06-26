// Real ocean surface current data.
//
// A free, live-updating, CORS-friendly ocean-current API does not exist without
// an account (NOAA OSCAR/Copernicus Marine require registration; the public
// ERDDAP mirrors found only serve archived data through ~2014-2018, not "live").
// Instead, this uses scientifically documented current systems — real named
// currents with real approximate speed (m/s) and routing, the same kind of
// reference data used in oceanography textbooks. It is accurate to how these
// currents actually behave, just not telemetry updated minute-to-minute.

export const CURRENT_PATHS = [
  { name: 'Gulf Stream', speed: 1.8, color: '#2de0c9',
    waypoints: [[25,-80],[28,-79],[33,-77],[37,-72],[42,-62],[47,-45],[50,-30]] },
  { name: 'Kuroshio Current', speed: 1.5, color: '#2de0c9',
    waypoints: [[20,123],[24,127],[30,136],[36,145],[41,153]] },
  { name: 'Antarctic Circumpolar Current', speed: 0.3, color: '#36c6ff',
    waypoints: [[-58,-180],[-58,-135],[-58,-90],[-58,-45],[-58,0],[-58,45],[-58,90],[-58,135],[-58,180]] },
  { name: 'Agulhas Current', speed: 1.7, color: '#2de0c9',
    waypoints: [[-25,33],[-29,32],[-34,28],[-38,22]] },
  { name: 'Brazil Current', speed: 0.5, color: '#36c6ff',
    waypoints: [[-8,-35],[-18,-39],[-28,-46],[-37,-53]] },
  { name: 'Benguela Current', speed: 0.3, color: '#36c6ff',
    waypoints: [[-15,12],[-23,13],[-33,16]] },
  { name: 'California Current', speed: 0.2, color: '#36c6ff',
    waypoints: [[45,-128],[38,-124],[30,-121],[23,-113]] },
  { name: 'North Equatorial Current', speed: 0.3, color: '#36c6ff',
    waypoints: [[12,-20],[12,-70],[12,-120],[12,-160]] },
  { name: 'East Australian Current', speed: 0.6, color: '#2de0c9',
    waypoints: [[-15,150],[-22,152],[-30,153],[-36,151]] },
  { name: 'Labrador Current', speed: 0.5, color: '#36c6ff',
    waypoints: [[60,-55],[55,-53],[49,-52],[44,-51]] },
];

// Expand each named current's waypoints into consecutive short segments so the
// route reads as a smooth curved flow rather than one long straight arc.
export function expandToSegments(paths) {
  const segs = [];
  paths.forEach(p => {
    for (let i = 0; i < p.waypoints.length - 1; i++) {
      const [lat1, lng1] = p.waypoints[i];
      const [lat2, lng2] = p.waypoints[i + 1];
      segs.push({ type: 'current', name: p.name, speed: p.speed, color: p.color, lat1, lng1, lat2, lng2 });
    }
  });
  return segs;
}
