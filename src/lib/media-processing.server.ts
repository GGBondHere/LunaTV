import { execFile } from 'child_process';
import { open } from 'fs/promises';
import { promisify } from 'util';

const execute = promisify(execFile);
export async function checkMediaTools() {
  await execute('ffprobe', ['-version'], { timeout: 5000, maxBuffer: 65536 });
  await execute('ffmpeg', ['-version'], { timeout: 5000, maxBuffer: 65536 });
}

export async function inspectMedia(file: string, remote = false) {
  if (!remote) {
    const handle = await open(file, 'r');
    const header = Buffer.alloc(16);
    try {
      await handle.read(header, 0, 16, 0);
    } finally {
      await handle.close();
    }
    if (
      header.toString('ascii', 4, 8) !== 'ftyp' ||
      header.toString('ascii', 8, 12) === 'qt  '
    ) {
      throw new Error(
        '视频容器不支持，请转换为 MP4（H.264 视频、AAC 音频）后上传'
      );
    }
  }
  const { stdout } = await execute(
    'ffprobe',
    [
      '-v',
      'error',
      '-protocol_whitelist',
      remote ? 'http,tcp' : 'file,pipe',
      '-enable_drefs',
      '0',
      '-f',
      'mov',
      '-show_entries',
      'stream=codec_type,codec_name,pix_fmt,width,height:format=duration',
      '-of',
      'json',
      file,
    ],
    { timeout: remote ? 60000 : 20000, maxBuffer: 512 * 1024 }
  );
  const info = JSON.parse(stdout) as {
    streams: {
      codec_type: string;
      codec_name: string;
      pix_fmt?: string;
      width?: number;
      height?: number;
    }[];
    format: { duration: string };
  };
  const videos = info.streams.filter((stream) => stream.codec_type === 'video');
  const audio = info.streams.filter((stream) => stream.codec_type === 'audio');
  const video = videos[0];
  const duration = Number(info.format.duration);
  if (
    videos.length !== 1 ||
    video.codec_name !== 'h264' ||
    !['yuv420p', 'yuvj420p'].includes(video.pix_fmt || '') ||
    audio.some((stream) => stream.codec_name !== 'aac') ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !video.width ||
    !video.height ||
    video.width > 8192 ||
    video.height > 8192
  ) {
    throw new Error(
      '视频编码不支持，请使用 MP4、8 位 H.264 视频及 AAC 音频（也可无音轨）'
    );
  }
  return { duration, width: video.width, height: video.height };
}

export async function createMediaCover(
  input: string,
  output: string,
  seconds?: number,
  remote = false
) {
  if (seconds === undefined) {
    const handle = await open(input, 'r');
    const header = Buffer.alloc(16);
    try {
      await handle.read(header, 0, 16, 0);
    } finally {
      await handle.close();
    }
    const image =
      header.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
      header
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      (header.toString('ascii', 0, 4) === 'RIFF' &&
        header.toString('ascii', 8, 12) === 'WEBP');
    if (!image) throw new Error('封面文件格式不支持');
    const { stdout } = await execute(
      'ffprobe',
      [
        '-v',
        'error',
        '-max_alloc',
        '67108864',
        '-protocol_whitelist',
        'file,pipe',
        '-show_entries',
        'stream=width,height',
        '-of',
        'json',
        input,
      ],
      { timeout: 10000, maxBuffer: 65536 }
    );
    const dimensions = JSON.parse(stdout).streams?.[0] as
      | { width?: number; height?: number }
      | undefined;
    if (
      !dimensions?.width ||
      !dimensions.height ||
      dimensions.width * dimensions.height > 16_777_216
    )
      throw new Error('封面尺寸过大');
  }
  await execute(
    'ffmpeg',
    [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-max_alloc',
      '67108864',
      '-protocol_whitelist',
      remote ? 'file,http,tcp' : 'file,pipe',
      ...(seconds === undefined ? [] : ['-enable_drefs', '0']),
      '-threads',
      '1',
      ...(seconds === undefined
        ? []
        : ['-ss', String(Math.min(1, seconds / 10))]),
      '-i',
      input,
      '-frames:v',
      '1',
      '-vf',
      'scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1',
      '-q:v',
      '3',
      '-update',
      '1',
      output,
    ],
    { timeout: 30000, maxBuffer: 65536 }
  );
}
