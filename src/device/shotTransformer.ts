// Vendored from github.com/biokys/gaggimate-mcp (src/transformers/). Keeps an
// archived shot shaped exactly like one read live from the device.
import { ShotData, ShotSample, PhaseTransition } from './parsers/binaryShot.js';

interface TransformedSample {
  time_seconds: number;
  temperature_c: number;
  pressure_bar: number;
  flow_ml_s: number;
  weight_g: number;
  // Setpoints, full curve only. The firmware writes 0 for the quantity a phase
  // is not controlled on (target pressure in a flow phase and the reverse),
  // which is emitted as null so a chart leaves a gap instead of a line on 0.
  // The flow target is for pump flow, not puck flow, so pump flow comes too.
  target_pressure_bar?: number | null;
  target_flow_ml_s?: number | null;
  target_temperature_c?: number | null;
  pump_flow_ml_s?: number;
}

export interface TransformOptions {
  /**
   * Profile phase indices known to be preinfusion, from the profile snapshot
   * archived with the shot. Without it, preinfusion is inferred from names.
   */
  preinfusionPhases?: Set<number>;
}

interface PhaseData {
  name: string;
  phase_number: number;
  start_time_seconds: number;
  duration_seconds: number;
  sample_count: number;
  avg_temperature_c: number;
  avg_pressure_bar: number;
  total_flow_ml: number;
  samples: TransformedSample[];
}

interface ShotSummary {
  temperature: {
    min_celsius: number;
    max_celsius: number;
    average_celsius: number;
    target_average: number;
  };
  pressure: {
    min_bar: number;
    max_bar: number;
    average_bar: number;
    peak_time_seconds: number;
  };
  flow: {
    total_volume_ml: number;
    average_flow_rate_ml_s: number;
    peak_flow_ml_s: number;
    time_to_first_drip_seconds: number | null;
  };
  extraction: {
    extraction_time_seconds: number;
    preinfusion_time_seconds: number;
    main_extraction_seconds: number;
  };
}

interface TransformedShot {
  metadata: {
    shot_id: string;
    profile_name: string;
    profile_id: string;
    timestamp: string;
    duration_seconds: number;
    final_weight_grams: number | null;
    sample_count: number;
    sample_interval_ms: number;
    bluetooth_scale_connected: boolean;
    volumetric_mode: boolean;
    /** When the controller stopped driving the pump; null for a log without setpoints. */
    extraction_end_seconds: number | null;
  };
  summary: ShotSummary;
  phases: PhaseData[];
  full_curve?: TransformedSample[];
}

/**
 * Index of the last sample of the extraction, or -1 for a log without
 * setpoints (take it whole). See transformShotForAI for why; shared with the
 * history's sparklines so every view cuts the same place.
 */
export function extractionEndIndex(samples: ShotSample[]): number {
  let last = -1;
  samples.forEach((s, i) => { if ((s.tp ?? 0) > 0 || (s.tf ?? 0) > 0) last = i; });
  if (last >= 0) while (last + 1 < samples.length && (samples[last + 1].pf ?? 0) > 0) last++;
  return last;
}

export function transformShotForAI(shot: ShotData, includeFullCurve: boolean = false, options: TransformOptions = {}): TransformedShot {
  // Extract bluetooth scale and volumetric info from first sample
  const firstSample = shot.samples[0];
  const bluetoothConnected = firstSample?.systemInfo?.bluetoothScaleConnected || false;
  const volumetricMode = firstSample?.systemInfo?.shotStartedVolumetric || false;

  // The log runs on for 2–3 s after the controller stops asking for anything
  // (target pressure and flow both 0): the 3-way valve closes, the pump runs
  // down into it, and the boiler side the sensor sits on climbs towards the OPV.
  // Shot 52 read 9.8 bar there after an extraction that peaked at 6.2. Only
  // the pressure is not the puck's any more: the cup still fills, and the
  // temperature and flow are still real. So pressure figures stop at the last
  // sample of the extraction and everything else runs to the end; the curve
  // keeps the tail, marked by extraction_end_seconds. A log with no setpoints
  // at all is taken whole.
  //
  // The extraction is the samples with a setpoint, and after the last one,
  // those where water still goes through the puck: the setpoint clears about
  // a quarter second before the valve closes (shot 53: target gone at 37.44 s,
  // puck flow 1.91 ml/s at 37.69, 0 at 37.94, and only then the climb). Pump
  // flow is no guide — it runs on into the closed valve, which is the climb.
  const lastDriven = extractionEndIndex(shot.samples);
  const pressureEnd = lastDriven >= 0 ? lastDriven + 1 : shot.samples.length;

  // Calculate summaries
  const summary = calculateSummary(shot, options, pressureEnd);

  // Process phases
  const phases = processPhases(shot, pressureEnd);

  // Build result
  const result: TransformedShot = {
    metadata: {
      shot_id: shot.id,
      profile_name: shot.profileName,
      profile_id: shot.profileId,
      timestamp: new Date(shot.timestamp * 1000).toISOString(),
      duration_seconds: shot.duration / 1000,
      final_weight_grams: shot.weight,
      sample_count: shot.sampleCount,
      sample_interval_ms: shot.sampleInterval,
      bluetooth_scale_connected: bluetoothConnected,
      volumetric_mode: volumetricMode,
      extraction_end_seconds: lastDriven >= 0 ? (shot.samples[lastDriven].t || 0) / 1000 : null,
    },
    summary,
    phases,
  };

  // Include full curve data if requested
  if (includeFullCurve) {
    result.full_curve = shot.samples.map(sample => ({
      time_seconds: (sample.t || 0) / 1000,
      temperature_c: sample.ct || 0,
      pressure_bar: sample.cp || 0,
      flow_ml_s: sample.pf || 0,
      weight_g: sample.v || 0,
      target_pressure_bar: sample.tp ? sample.tp : null,
      target_flow_ml_s: sample.tf ? sample.tf : null,
      target_temperature_c: sample.tt ? sample.tt : null,
      pump_flow_ml_s: sample.fl || 0,
    }));
  }

  return result;
}

function calculateSummary(shot: ShotData, options: TransformOptions, pressureEnd: number): ShotSummary {
  const samples = shot.samples;

  // Temperature statistics
  const temperatures = samples.map(s => s.ct || 0).filter(t => t > 0);
  const targetTemps = samples.map(s => s.tt || 0).filter(t => t > 0);

  // Pressure statistics, up to the end of the extraction (see transformShotForAI)
  const pressures = samples.slice(0, pressureEnd).map(s => s.cp || 0);
  const maxPressure = Math.max(...pressures);
  const peakPressureIndex = pressures.indexOf(maxPressure);
  const peakPressureTime = (samples[peakPressureIndex]?.t || 0) / 1000;
  
  // Flow statistics
  const flows = samples.map(s => s.pf || 0); // Use puck flow as it's the actual flow through coffee
  const totalVolume = calculateTotalVolume(samples, shot.sampleInterval);
  const nonZeroFlows = flows.filter(f => f > 0);
  const avgFlow = nonZeroFlows.length > 0 
    ? nonZeroFlows.reduce((a, b) => a + b, 0) / nonZeroFlows.length 
    : 0;
  
  // Find time to first drip (first positive weight or flow)
  let timeToFirstDrip: number | null = null;
  for (let i = 0; i < samples.length; i++) {
    if ((samples[i].v && samples[i].v! > 0.5) || (samples[i].pf && samples[i].pf! > 0.1)) {
      timeToFirstDrip = (samples[i].t || 0) / 1000;
      break;
    }
  }
  
  // Calculate preinfusion time (based on phases if available)
  let preinfusionTime = 0;
  if (shot.phases.length > 0) {
    // Find the end of preinfusion phases (usually phase 0, 1, and sometimes 2 for soak).
    // The .slog keeps only the phase's name, not its type. The profile snapshot
    // archived with the shot knows the type; without one the name is all there
    // is: fold case and drop separators so "Pre-infusion" matches, and count a
    // leading fill or bloom too — "Fill > Pre-infusion > Hold" read as 0 s.
    const isPreinfusion = (phase: PhaseTransition) =>
      options.preinfusionPhases
        ? options.preinfusionPhases.has(phase.phaseNumber)
        : /preinfusion|soak|fill|bloom/.test(phase.phaseName.toLowerCase().replace(/[^a-z]/g, ''));
    for (const phase of shot.phases) {
      if (isPreinfusion(phase)) {
        const phaseEndIndex = shot.phases.indexOf(phase) < shot.phases.length - 1 
          ? shot.phases[shot.phases.indexOf(phase) + 1].sampleIndex 
          : shot.samples.length;
        const phaseEndTime = (shot.samples[phaseEndIndex - 1]?.t || 0) / 1000;
        preinfusionTime = Math.max(preinfusionTime, phaseEndTime);
      }
    }
  }
  
  return {
    temperature: {
      min_celsius: Math.min(...temperatures),
      max_celsius: Math.max(...temperatures),
      average_celsius: temperatures.reduce((a, b) => a + b, 0) / temperatures.length,
      target_average: targetTemps.reduce((a, b) => a + b, 0) / targetTemps.length,
    },
    pressure: {
      min_bar: Math.min(...pressures),
      max_bar: maxPressure,
      average_bar: pressures.reduce((a, b) => a + b, 0) / pressures.length,
      peak_time_seconds: peakPressureTime,
    },
    flow: {
      total_volume_ml: totalVolume,
      average_flow_rate_ml_s: avgFlow,
      peak_flow_ml_s: Math.max(...flows),
      time_to_first_drip_seconds: timeToFirstDrip,
    },
    extraction: {
      extraction_time_seconds: shot.duration / 1000,
      preinfusion_time_seconds: preinfusionTime,
      main_extraction_seconds: (shot.duration / 1000) - preinfusionTime,
    },
  };
}

function calculateTotalVolume(samples: ShotSample[], intervalMs: number): number {
  // Integrate flow over time to get volume
  let totalVolume = 0;
  const intervalSeconds = intervalMs / 1000;
  
  for (const sample of samples) {
    const flow = sample.pf || 0; // ml/s
    totalVolume += flow * intervalSeconds; // ml
  }
  
  return Math.round(totalVolume * 10) / 10; // Round to 0.1 ml
}

function processPhases(shot: ShotData, pressureEnd: number): PhaseData[] {
  const phases: PhaseData[] = [];
  const samples = shot.samples;

  for (let i = 0; i < shot.phases.length; i++) {
    const phase = shot.phases[i];
    const nextPhase = shot.phases[i + 1];

    const startIndex = phase.sampleIndex;
    const endIndex = nextPhase ? nextPhase.sampleIndex : samples.length;
    const phaseSamples = samples.slice(startIndex, endIndex);

    if (phaseSamples.length === 0) continue;

    // Calculate phase statistics; pressure without the post-extraction tail
    const temperatures = phaseSamples.map(s => s.ct || 0).filter(t => t > 0);
    const pressures = samples.slice(startIndex, Math.min(endIndex, pressureEnd)).map(s => s.cp || 0);
    const totalFlow = calculateTotalVolume(phaseSamples, shot.sampleInterval);
    
    // Select representative samples (beginning, middle, end)
    const representativeSamples: TransformedSample[] = [];
    const indices = [
      0, // First
      Math.floor(phaseSamples.length / 2), // Middle
      phaseSamples.length - 1, // Last
    ];
    
    // Remove duplicates if phase is very short
    const uniqueIndices = [...new Set(indices)];
    
    for (const idx of uniqueIndices) {
      const sample = phaseSamples[idx];
      if (sample) {
        representativeSamples.push({
          time_seconds: (sample.t || 0) / 1000,
          temperature_c: sample.ct || 0,
          pressure_bar: sample.cp || 0,
          flow_ml_s: sample.pf || 0,
          weight_g: sample.v || 0,
        });
      }
    }
    
    const startTime = (phaseSamples[0].t || 0) / 1000;
    const endTime = (phaseSamples[phaseSamples.length - 1].t || 0) / 1000;
    
    phases.push({
      name: phase.phaseName,
      phase_number: phase.phaseNumber,
      start_time_seconds: startTime,
      duration_seconds: endTime - startTime,
      sample_count: phaseSamples.length,
      avg_temperature_c: temperatures.length > 0 
        ? Math.round(temperatures.reduce((a, b) => a + b, 0) / temperatures.length * 10) / 10
        : 0,
      avg_pressure_bar: pressures.length > 0
        ? Math.round(pressures.reduce((a, b) => a + b, 0) / pressures.length * 10) / 10
        : 0,
      total_flow_ml: totalFlow,
      samples: representativeSamples,
    });
  }
  
  // Handle case where there are no phases defined
  if (phases.length === 0 && samples.length > 0) {
    // Create a single phase for the entire shot
    const temperatures = samples.map(s => s.ct || 0).filter(t => t > 0);
    const pressures = samples.map(s => s.cp || 0);
    const totalFlow = calculateTotalVolume(samples, shot.sampleInterval);
    
    const representativeSamples: TransformedSample[] = [];
    const indices = [0, Math.floor(samples.length / 2), samples.length - 1];
    const uniqueIndices = [...new Set(indices)];
    
    for (const idx of uniqueIndices) {
      const sample = samples[idx];
      if (sample) {
        representativeSamples.push({
          time_seconds: (sample.t || 0) / 1000,
          temperature_c: sample.ct || 0,
          pressure_bar: sample.cp || 0,
          flow_ml_s: sample.pf || 0,
          weight_g: sample.v || 0,
        });
      }
    }
    
    phases.push({
      name: 'extraction',
      phase_number: 0,
      start_time_seconds: 0,
      duration_seconds: shot.duration / 1000,
      sample_count: samples.length,
      avg_temperature_c: temperatures.length > 0
        ? Math.round(temperatures.reduce((a, b) => a + b, 0) / temperatures.length * 10) / 10
        : 0,
      avg_pressure_bar: pressures.length > 0
        ? Math.round(pressures.reduce((a, b) => a + b, 0) / pressures.length * 10) / 10
        : 0,
      total_flow_ml: totalFlow,
      samples: representativeSamples,
    });
  }
  
  return phases;
}