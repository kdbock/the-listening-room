#!/usr/bin/env python3
"""Build the Chapter 1, Part 1 sound-design pilot from original local synthesis."""

from __future__ import annotations

from pathlib import Path
import wave

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "local-narrator" / "parts-wav" / "01-01-part-01.wav"
OUTPUT_DIR = ROOT / "local-narrator" / "sound-designed" / "01-01-part-01"
RATE = 24_000
DURATION = 226.20
N = round(RATE * DURATION)
RNG = np.random.default_rng(20260713)


def read_mono(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as audio:
        if audio.getnchannels() != 1 or audio.getsampwidth() != 2:
            raise ValueError(f"Expected 16-bit mono WAV: {path}")
        if audio.getframerate() != RATE:
            raise ValueError(f"Expected {RATE} Hz audio: {path}")
        return np.frombuffer(audio.readframes(audio.getnframes()), dtype=np.int16).astype(np.float64) / 32768.0


def write_stereo(path: Path, audio: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    clipped = np.clip(audio, -1.0, 1.0)
    pcm = np.round(clipped * 32767.0).astype(np.int16)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(RATE)
        output.writeframes(pcm.tobytes())


def seconds(value: float) -> int:
    return max(0, min(N, round(value * RATE)))


def smoothstep(size: int, reverse: bool = False) -> np.ndarray:
    if size <= 0:
        return np.empty(0)
    x = np.linspace(0.0, 1.0, size, endpoint=True)
    y = x * x * (3.0 - 2.0 * x)
    return y[::-1] if reverse else y


def cue_envelope(start: float, end: float, attack: float = 0.8, release: float = 1.2) -> np.ndarray:
    env = np.zeros(N)
    a, b = seconds(start), seconds(end)
    env[a:b] = 1.0
    attack_n = min(seconds(attack), max(0, b - a))
    release_n = min(seconds(release), max(0, b - a))
    if attack_n:
        env[a : a + attack_n] *= smoothstep(attack_n)
    if release_n:
        env[b - release_n : b] *= smoothstep(release_n, reverse=True)
    return env


def control_noise(spacing_seconds: float, stereo_spread: float = 0.18) -> np.ndarray:
    spacing = max(2, seconds(spacing_seconds))
    anchors = np.arange(0, N + spacing, spacing)
    base = RNG.normal(0.0, 1.0, anchors.size)
    side = RNG.normal(0.0, 1.0, anchors.size)
    indexes = np.arange(N)
    center = np.interp(indexes, anchors, base)
    width = np.interp(indexes, anchors, side) * stereo_spread
    return np.column_stack((center + width, center - width))


def moving_average(signal: np.ndarray, window: int) -> np.ndarray:
    window = max(1, int(window))
    padded = np.pad(signal, (window, 0), mode="reflect")
    cumulative = np.cumsum(padded, dtype=np.float64)
    return ((cumulative[window:] - cumulative[:-window]) / window)[: signal.size]


def audible_band_noise(count: int, low_hz: float, high_hz: float) -> np.ndarray:
    """Broadband noise that survives laptop and phone speakers."""
    white = RNG.normal(0.0, 1.0, count)
    upper = moving_average(white, max(1, round(RATE / high_hz)))
    lower = moving_average(white, max(2, round(RATE / low_hz)))
    result = upper - lower
    return result / (np.sqrt(np.mean(result * result)) + 1e-12)


def normalize_rms(audio: np.ndarray, target_db: float, mask: np.ndarray | None = None) -> np.ndarray:
    values = audio if mask is None else audio[mask]
    if values.size == 0:
        return audio
    rms = np.sqrt(np.mean(values * values))
    if rms <= 1e-12:
        return audio
    return audio * ((10.0 ** (target_db / 20.0)) / rms)


def pan_mono(signal: np.ndarray, pan: float = 0.0) -> np.ndarray:
    pan = float(np.clip(pan, -1.0, 1.0))
    angle = (pan + 1.0) * np.pi / 4.0
    return np.column_stack((signal * np.cos(angle), signal * np.sin(angle)))


def place(track: np.ndarray, signal: np.ndarray, start: float, pan: float = 0.0, gain: float = 1.0) -> None:
    a = seconds(start)
    b = min(N, a + signal.size)
    if b > a:
        track[a:b] += pan_mono(signal[: b - a], pan) * gain


def pad(start: float, end: float, frequencies: list[tuple[float, float]], tremolo: float = 0.07) -> np.ndarray:
    a, b = seconds(start), seconds(end)
    count = b - a
    t = np.arange(count) / RATE
    signal = np.zeros(count)
    for index, (frequency, weight) in enumerate(frequencies):
        drift = 0.0022 * np.sin(2 * np.pi * (0.031 + index * 0.008) * t + index)
        phase = 2 * np.pi * frequency * t + drift
        signal += weight * np.sin(phase)
        signal += weight * 0.17 * np.sin(phase * 2.002 + 0.7)
    signal *= 1.0 + tremolo * np.sin(2 * np.pi * 0.11 * t)
    local = cue_envelope(start, end, min(2.2, (end - start) / 3), min(2.8, (end - start) / 3))[a:b]
    return signal * local


def token_pulse(duration: float = 1.2, insistence: float = 1.0) -> np.ndarray:
    count = seconds(duration)
    t = np.arange(count) / RATE
    attack = np.minimum(1.0, t / 0.018)
    decay = np.exp(-t * (4.0 / duration))
    partials = (
        np.sin(2 * np.pi * 246.0 * t)
        + 0.46 * np.sin(2 * np.pi * 397.0 * t + 0.2)
        + 0.22 * np.sin(2 * np.pi * 731.0 * t + 0.8)
        + 0.08 * np.sin(2 * np.pi * 1217.0 * t + 1.3)
    )
    warm = 0.18 * np.sin(2 * np.pi * (96.0 + 14.0 * t) * t) * np.exp(-t * 6.0)
    return (partials + warm) * attack * decay * insistence


def low_groan(duration: float, start_frequency: float, end_frequency: float, roughness: float = 0.12) -> np.ndarray:
    count = seconds(duration)
    t = np.arange(count) / RATE
    slope = (end_frequency - start_frequency) / max(duration, 0.001)
    phase = 2 * np.pi * (start_frequency * t + 0.5 * slope * t * t)
    body = (
        np.sin(phase)
        + 0.31 * np.sin(phase * 1.997 + 0.4)
        + 0.18 * np.sin(phase * 3.013 + 0.9)
        + 0.08 * np.sin(phase * 5.021 + 1.2)
    )
    grain = audible_band_noise(count, 170.0, 2400.0) * roughness
    env = np.sin(np.pi * np.linspace(0.0, 1.0, count)) ** 1.7
    return (body + grain) * env


def build_ambience() -> np.ndarray:
    wind_left = audible_band_noise(N, 140.0, 2500.0)
    wind_right = audible_band_noise(N, 155.0, 2800.0)
    wind_mod = control_noise(0.85, 0.22)
    wind_mod -= np.min(wind_mod, axis=0)
    wind_mod /= np.max(wind_mod, axis=0) + 1e-12
    wind = np.column_stack((wind_left, wind_right)) * (0.38 + 0.62 * wind_mod)

    water_left = audible_band_noise(N, 220.0, 1100.0)
    water_right = audible_band_noise(N, 250.0, 1250.0)
    water_motion = np.column_stack((water_left, water_right))
    t = np.arange(N) / RATE
    water = water_motion * (0.28 + 0.24 * np.maximum(0.0, np.sin(2 * np.pi * 0.17 * t)))[:, None]
    ambience = wind * 0.73 + water * 0.27
    env = cue_envelope(2.70, 226.20, 3.0, 2.5)
    env *= 0.72
    env[seconds(18.89) : seconds(112.40)] *= 0.68
    env[seconds(112.40) : seconds(135.85)] *= 1.22
    env[seconds(135.85) : seconds(177.03)] *= 0.68
    env[seconds(177.03) : seconds(223.00)] *= 0.55
    ambience *= env[:, None]

    distant = low_groan(7.95, 47.0, 34.0, 0.05)
    place(ambience, distant, 10.35, pan=-0.32, gain=0.17)
    return normalize_rms(ambience, -38.0, env > 0.1)


def build_music() -> np.ndarray:
    music = np.zeros((N, 2))

    opening = pad(0.0, 18.89, [(82.4, 1.0), (123.6, 0.48), (247.0, 0.16)])
    glass_t = np.arange(opening.size) / RATE
    opening += 0.055 * np.sin(2 * np.pi * 741.0 * glass_t) * np.sin(np.pi * np.arange(opening.size) / opening.size) ** 2
    place(music, opening, 0.0, pan=0.0, gain=1.0)

    first_shadow = pad(59.68, 64.80, [(92.5, 1.0), (138.6, 0.32)])
    second_shadow = pad(64.65, 69.01, [(87.3, 1.0), (130.8, 0.34)])
    place(music, first_shadow, 59.68, pan=-0.12, gain=0.72)
    place(music, second_shadow, 64.65, pan=0.12, gain=0.78)

    presence = pad(177.03, 190.71, [(110.0, 1.0), (164.8, 0.29), (330.0, 0.06)])
    place(music, presence, 177.03, pan=0.0, gain=0.76)

    order = pad(190.71, 223.00, [(77.8, 1.0), (116.6, 0.38), (233.2, 0.10)], tremolo=0.03)
    pulse_t = np.arange(order.size) / RATE
    pulses = 0.68 + 0.32 * np.maximum(0.0, np.sin(2 * np.pi * 0.245 * pulse_t - np.pi / 2)) ** 2
    order *= pulses
    place(music, order, 190.71, pan=0.0, gain=0.94)

    tail = pad(222.90, 226.20, [(73.4, 1.0), (110.0, 0.28)], tremolo=0.0)
    place(music, tail, 222.90, pan=0.0, gain=0.80)
    mask = np.max(np.abs(music), axis=1) > 1e-7
    return normalize_rms(music, -36.0, mask)


def build_effects() -> np.ndarray:
    effects = np.zeros((N, 2))

    hull = low_groan(5.10, 74.0, 38.0, 0.19)
    ice = control_noise(0.012, 0.0)[: hull.size, 0] * np.sin(np.pi * np.linspace(0.0, 1.0, hull.size)) ** 2
    place(effects, hull + 0.13 * ice, 124.70, pan=-0.42, gain=0.070)

    place(effects, token_pulse(1.20, 1.0), 135.90, pan=-0.24, gain=0.031)
    place(effects, token_pulse(1.10, 1.08), 144.25, pan=-0.20, gain=0.033)

    count = seconds(3.17)
    t = np.arange(count) / RATE
    inward = np.sin(2 * np.pi * (83.0 - 9.0 * t) * t) * np.exp(-t * 0.82)
    shimmer = 0.28 * np.sin(2 * np.pi * 332.0 * t + 4.0 * np.sin(2 * np.pi * 1.8 * t)) * np.exp(-t * 1.8)
    reverse_swell = np.minimum(1.0, t / 0.42) * np.exp(-np.maximum(0.0, t - 0.50) * 1.45)
    place(effects, (inward + shimmer) * reverse_swell, 177.03, pan=0.10, gain=0.032)

    hit = low_groan(3.30, 53.0, 29.0, 0.23)
    hit_t = np.arange(hit.size) / RATE
    hit *= np.exp(-hit_t * 0.72)
    place(effects, hit, 223.10, pan=-0.08, gain=0.054)
    return effects * 1.28


def voice_duck_envelope(voice: np.ndarray) -> np.ndarray:
    block = seconds(0.05)
    rms = []
    for start in range(0, voice.size, block):
        chunk = voice[start : start + block]
        rms.append(np.sqrt(np.mean(chunk * chunk) + 1e-12))
    rms = np.asarray(rms)
    activity = np.clip((20 * np.log10(rms + 1e-12) + 48.0) / 18.0, 0.0, 1.0)
    expanded = np.repeat(activity, block)[: voice.size]
    smooth = np.convolve(expanded, np.ones(seconds(0.16)) / seconds(0.16), mode="same")
    duck = 1.0 - 0.05 * smooth
    padded = np.ones(N)
    padded[: voice.size] = duck
    return padded


def diction_clearance_envelope() -> np.ndarray:
    """Keep the first 'Nix' after the opening motif perceptually unambiguous."""
    envelope = np.ones(N)
    fade_out_start = seconds(18.15)
    silent_start = seconds(18.55)
    silent_end = seconds(19.75)
    fade_in_end = seconds(20.55)
    envelope[fade_out_start:silent_start] = smoothstep(silent_start - fade_out_start, reverse=True)
    envelope[silent_start:silent_end] = 0.0
    envelope[silent_end:fade_in_end] = smoothstep(fade_in_end - silent_end)
    return envelope


def main() -> None:
    voice_mono = read_mono(SOURCE)
    voice = np.zeros((N, 2))
    narration_gain = 10.0 ** (2.5 / 20.0)
    voice[: voice_mono.size] = pan_mono(voice_mono, 0.0) * np.sqrt(2.0) * narration_gain

    ambience = build_ambience()
    music = build_music()
    effects = build_effects()
    duck = voice_duck_envelope(voice_mono)
    clearance = diction_clearance_envelope()
    ambience *= (duck * clearance)[:, None]
    music *= (duck * clearance)[:, None]

    sfx_mix = voice + ambience + effects
    sfx_peak = np.max(np.abs(sfx_mix))
    ceiling = 10.0 ** (-1.0 / 20.0)
    if sfx_peak > ceiling:
        sfx_mix *= ceiling / sfx_peak

    mix = voice + ambience + music + effects
    peak = np.max(np.abs(mix))
    if peak > ceiling:
        mix *= ceiling / peak

    write_stereo(OUTPUT_DIR / "01-narration.wav", voice)
    write_stereo(OUTPUT_DIR / "02-wintersong-ambience.wav", ambience)
    write_stereo(OUTPUT_DIR / "03-music.wav", music)
    write_stereo(OUTPUT_DIR / "04-effects.wav", effects)
    write_stereo(OUTPUT_DIR / "01-01-part-01-with-sfx.wav", sfx_mix)
    write_stereo(OUTPUT_DIR / "01-01-part-01-sound-designed-pilot-v7-voice-priority.wav", mix)

    print(f"Created sound-design pilot in {OUTPUT_DIR}")
    print(f"Duration: {DURATION:.2f} seconds")
    print(f"Peak: {20 * np.log10(np.max(np.abs(mix)) + 1e-12):.2f} dBFS")


if __name__ == "__main__":
    main()
