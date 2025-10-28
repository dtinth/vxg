import { GoogleGenAI } from "@google/genai";
import { useStore } from "@nanostores/react";
import { Action, ActionPanel, getPreferenceValues, Icon, List } from "@raycast/api";
import { atom } from "nanostores";
import { computedDynamic } from "nanostores-computed-dynamic";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ReactElement, useEffect, useState } from "react";
import { uuidv7 } from "uuidv7";

function transcribe(buffer: Buffer) {
  const { gemini_api_key } = getPreferenceValues<{ gemini_api_key: string; default_action: string }>();
  const ai = new GoogleGenAI({ apiKey: gemini_api_key });
  return ai.models.generateContentStream({
    model: "gemini-2.5-flash",
    contents: [
      {
        parts: [
          {
            text:
              "Please transcribe any speech in this audio. " +
              "Ignore non-speech elements. " +
              "For Thai text, only add spaces between sentences, phrases, or between Thai and non-Thai words. Do not add spaces between Thai words in the same sentence. " +
              "Before responding, in your thinking process, draft the first 20 words, and refine the transcript, such as spacing and word usage. " +
              'If there is no speech, respond with "No speech detected". ' +
              "Here comes the audio: <audio>",
          },
          {
            inlineData: {
              mimeType: "audio/mp3",
              data: buffer.toString("base64"),
            },
          },
          {
            text: "</audio>",
          },
        ],
      },
    ],
    config: {
      thinkingConfig: {
        includeThoughts: true,
        thinkingBudget: 512,
      },
    },
  });
}

function extractTimestampFromUUIDv7(uuid: string): number {
  // UUIDv7 format: first 48 bits are Unix timestamp in milliseconds
  // UUID format: xxxxxxxx-xxxx-7xxx-xxxx-xxxxxxxxxxxx
  // First 8 hex chars (32 bits) + next 4 hex chars (16 bits) = 48 bits timestamp
  const hex = uuid.replace(/-/g, "");
  const timestampHex = hex.substring(0, 12); // First 48 bits (12 hex chars)
  const timestamp = parseInt(timestampHex, 16);
  return timestamp;
}

const nullRecorder = {
  $duration: atom("00:00:00.00"),
  $levels: atom("[      |      ]"),
};

const LOG_PATH = "/tmp/vxg/transcription-log.ndjson";

interface LogEntry {
  recordingId: string;
  createdAt: number;
  audioLengthSeconds?: number;
  inputTokens?: number;
  outputTokens?: number;
  thoughtsTokens?: number;
  transcriptionLength: number;
}

interface ControllerState {
  recordingItemKey: string;
  currentRecording: Recording | null;
  stoppedRecordings: Recording[];
}

class RecordingController {
  $state = atom<ControllerState>({
    recordingItemKey: uuidv7(),
    currentRecording: null,
    stoppedRecordings: [],
  });
  startRecording() {
    console.log("Recording started");
    const currentState = this.$state.get();
    const currentKey = currentState.recordingItemKey;
    const recording = new Recording({
      key: currentKey,
      onStopped: () => {
        const state = this.$state.get();
        if (state.currentRecording === recording) {
          this.$state.set({
            recordingItemKey: uuidv7(),
            currentRecording: null,
            stoppedRecordings: [recording, ...state.stoppedRecordings],
          });
        }
      },
    });
    this.$state.set({
      ...currentState,
      currentRecording: recording,
    });
  }
  deleteRecording(recording: Recording) {
    const state = this.$state.get();
    const updated = state.stoppedRecordings.filter((r) => r.id !== recording.id);
    this.$state.set({
      ...state,
      stoppedRecordings: updated,
    });
  }
  $list = computedDynamic((use): ReactElement[] => {
    const state = use(this.$state);
    const { recordingItemKey, currentRecording, stoppedRecordings } = state;
    const isRecording = !!currentRecording;

    const listItems: ReactElement[] = [];

    // Add recording item
    listItems.push(
      <List.Item
        key={recordingItemKey}
        title={isRecording ? "Now recording…" : "Start recording"}
        icon={isRecording ? Icon.Stop : Icon.CircleFilled}
        actions={
          <ActionPanel>
            <Action
              title={isRecording ? "Stop Recording" : "Start Recording"}
              icon={isRecording ? Icon.Stop : Icon.CircleFilled}
              onAction={isRecording ? () => currentRecording.stop() : () => this.startRecording()}
            />
          </ActionPanel>
        }
        detail={isRecording ? <CurrentRecordingDetail currentRecording={currentRecording} /> : null}
      />,
    );

    // Add stopped recordings
    for (const recording of stoppedRecordings) {
      const transcription = use(recording.$transcription);
      listItems.push(
        <List.Item
          key={recording.key}
          title={formatTime(recording.createdAt)}
          subtitle={transcription?.transcription || ""}
          icon={Icon.Microphone}
          detail={<StoppedRecordingDetail recording={recording} />}
          actions={<StoppedRecordingActions recording={recording} onDelete={() => this.deleteRecording(recording)} />}
        />,
      );
    }

    return listItems;
  });
  async loadPastRecordings() {
    try {
      const logContent = await readFile(LOG_PATH, "utf8");
      const lines = logContent
        .trim()
        .split("\n")
        .filter((line) => line.trim());

      // Parse all log entries
      const logEntries: LogEntry[] = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as LogEntry;
          logEntries.push(entry);
        } catch (error) {
          console.warn("Failed to parse log entry:", line, error);
        }
      }

      // Filter entries within the last day
      const oneHourAgo = Date.now() - 60 * 60 * 24 * 1000;
      const recentEntries = logEntries.filter((entry) => {
        try {
          const timestamp = entry.createdAt ?? extractTimestampFromUUIDv7(entry.recordingId);
          return timestamp >= oneHourAgo;
        } catch (error) {
          console.warn(`Failed to extract timestamp from entry:`, entry, error);
          return false;
        }
      });

      // Sort by timestamp (newest first) and take the latest 10
      recentEntries.sort((a, b) => {
        const timeA = a.createdAt ?? extractTimestampFromUUIDv7(a.recordingId);
        const timeB = b.createdAt ?? extractTimestampFromUUIDv7(b.recordingId);
        return timeB - timeA;
      });
      const latestEntries = recentEntries.slice(0, 10);

      // Load recordings from log entries
      const recordings: Recording[] = [];
      for (const entry of latestEntries) {
        try {
          const mp3Path = `/tmp/vxg/${entry.recordingId}.mp3`;
          const txtPath = `/tmp/vxg/${entry.recordingId}.txt`;

          // Check if files exist by trying to read them
          const transcriptionText = await readFile(txtPath, "utf8");

          // Verify mp3 exists (we don't need to read it, just check)
          await readFile(mp3Path);

          // Create recording from log entry
          const recording = Recording.fromLogEntry(entry, transcriptionText);
          recordings.push(recording);
        } catch (error) {
          // Skip entries where files are missing
          console.warn(`Skipping recording ${entry.recordingId}: files not found`, error);
        }
      }

      // Update state with loaded recordings
      const currentState = this.$state.get();
      this.$state.set({
        ...currentState,
        stoppedRecordings: [...recordings, ...currentState.stoppedRecordings],
      });

      console.log(`Loaded ${recordings.length} past recordings`);
    } catch (error) {
      // Log file doesn't exist or other error - just continue
      console.warn("Could not load past recordings:", error);
    }
  }
}

interface TranscriptionState {
  finished: boolean;
  transcription: string;
  error: string | null;
  latestThought?: string;
  inputTokens?: number;
  outputTokens?: number;
  thoughtsTokens?: number;
  audioLengthSeconds?: number;
}

class Recording {
  id: string;
  key: string;
  createdAt: number;
  $duration = atom(0);
  $transcription = atom<TranscriptionState | null>(null);
  $status = atom<"recording" | "stopping" | "stopped">("recording");
  recorder?: AudioRecorder;
  private abortController?: AbortController;
  private options?: { key: string; onStopped: () => void };

  constructor(config: { key: string; onStopped: () => void } | { id: string; key: string; createdAt: number }) {
    if ("onStopped" in config) {
      // New recording mode
      this.id = uuidv7();
      this.key = config.key;
      this.createdAt = Date.now();
      this.options = config;
      this.abortController = new AbortController();
      this.recorder = new AudioRecorder(this.id, this.abortController.signal);
      this.recorder.finishPromise.then(() => {
        this.$status.set("stopped");
        this.options!.onStopped();
        mkdirSync(dirname(this.mp3Path), { recursive: true });
        writeFileSync(this.mp3Path, this.recorder!.getBuffer());
        this.transcribe();
      });
    } else {
      // Loaded from log mode
      this.id = config.id;
      this.key = config.key;
      this.createdAt = config.createdAt;
      this.$status.set("stopped");
    }
  }

  static fromLogEntry(logEntry: LogEntry, transcriptionText: string): Recording {
    const createdAt = logEntry.createdAt ?? extractTimestampFromUUIDv7(logEntry.recordingId);
    const recording = new Recording({
      id: logEntry.recordingId,
      key: logEntry.recordingId,
      createdAt,
    });
    recording.$transcription.set({
      finished: true,
      transcription: transcriptionText,
      error: null,
      audioLengthSeconds: logEntry.audioLengthSeconds,
      inputTokens: logEntry.inputTokens,
      outputTokens: logEntry.outputTokens,
      thoughtsTokens: logEntry.thoughtsTokens,
    });
    return recording;
  }
  get mp3Path() {
    return `/tmp/vxg/${this.id}.mp3`;
  }
  get txtPath() {
    return `/tmp/vxg/${this.id}.txt`;
  }
  stop() {
    if (this.$status.get() !== "recording") {
      return;
    }
    this.$status.set("stopping");
    this.abortController?.abort();
  }
  async transcribe() {
    if (this.$transcription.get() && !this.$transcription.get()!.finished) {
      return;
    }
    if (!this.recorder) {
      console.error("Cannot transcribe: no recorder available");
      return;
    }
    const buffer = this.recorder.getBuffer();
    const audioLengthSeconds = buffer.length / (128000 / 8); // Approximate for 128kbps MP3
    this.$transcription.set({
      finished: false,
      transcription: "",
      error: null,
      latestThought: undefined,
      inputTokens: undefined,
      outputTokens: undefined,
      thoughtsTokens: undefined,
      audioLengthSeconds,
    });
    let transcription = "";
    try {
      const stream = await transcribe(buffer);
      for await (const chunk of stream) {
        let latestThought: string | undefined;
        for (const part of chunk.candidates?.[0]?.content?.parts || []) {
          if (part.thought) {
            console.log("Thought:", part.text);
            const thoughtMatch = part.text?.match(/\*\*(.+?)\*\*/);
            if (thoughtMatch) {
              latestThought = thoughtMatch[1];
            }
          }
        }
        if (chunk.text) {
          transcription += chunk.text;
        }
        const currentState = this.$transcription.get();
        this.$transcription.set({
          finished: false,
          transcription,
          error: null,
          latestThought,
          inputTokens: chunk.usageMetadata?.promptTokenCount || currentState?.inputTokens,
          outputTokens: chunk.usageMetadata?.candidatesTokenCount || currentState?.outputTokens,
          thoughtsTokens: chunk.usageMetadata?.thoughtsTokenCount || currentState?.thoughtsTokens,
          audioLengthSeconds: currentState?.audioLengthSeconds,
        });
      }
      const finalState = this.$transcription.get();
      this.$transcription.set({
        finished: true,
        transcription,
        error: null,
        latestThought: undefined,
        inputTokens: finalState?.inputTokens,
        outputTokens: finalState?.outputTokens,
        thoughtsTokens: finalState?.thoughtsTokens,
        audioLengthSeconds: finalState?.audioLengthSeconds,
      });

      // Write transcription to .txt file
      writeFileSync(this.txtPath, transcription, "utf8");

      // Append metadata to log file
      const logEntry = {
        recordingId: this.id,
        createdAt: this.createdAt,
        audioLengthSeconds: finalState?.audioLengthSeconds,
        inputTokens: finalState?.inputTokens,
        outputTokens: finalState?.outputTokens,
        thoughtsTokens: finalState?.thoughtsTokens,
        transcriptionLength: transcription.length,
      };
      appendFileSync(LOG_PATH, JSON.stringify(logEntry) + "\n", "utf8");
    } catch (error: unknown) {
      const finalState = this.$transcription.get();
      this.$transcription.set({
        finished: true,
        transcription,
        error: String(error),
        latestThought: undefined,
        inputTokens: finalState?.inputTokens,
        outputTokens: finalState?.outputTokens,
        thoughtsTokens: finalState?.thoughtsTokens,
        audioLengthSeconds: finalState?.audioLengthSeconds,
      });
      console.error("Error during transcription:", error);
      return;
    }
  }
}

class AudioRecorder {
  $levels = atom("[      |      ]");
  $duration = atom("00:00:00.00");
  finishPromise: Promise<void>;
  buffers: Buffer[] = [];
  constructor(
    private id: string,
    abortSignal: AbortSignal,
  ) {
    const child = spawn(`/opt/homebrew/bin/sox -c 1 -t coreaudio default -t mp3 -C 128 --buffer 256 -`, {
      shell: true,
    });
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (c) => {
      const levelMatch = c.match(/\[[-= |]+\]/);
      if (levelMatch) {
        this.$levels.set(levelMatch[0]);
      }

      const durationMatch = c.match(/\d\d:\d\d:\d\d\.\d\d/);
      if (durationMatch) {
        this.$duration.set(durationMatch[0]);
      }
    });
    child.stdout.on("data", (c) => {
      this.buffers.push(c);
    });
    abortSignal.addEventListener("abort", () => {
      child.kill("SIGINT");
    });
    this.finishPromise = new Promise((resolve) => {
      child.on("close", () => {
        resolve();
      });
    });
  }
  getBuffer() {
    return Buffer.concat(this.buffers);
  }
}

export default function Command() {
  const [controller] = useState(() => new RecordingController());
  const listItems = useStore(controller.$list);
  useEffect(() => {
    const load = setTimeout(() => {
      controller.loadPastRecordings();
    }, 100);
    return () => {
      clearTimeout(load);
    };
  }, [controller]);
  return <List isShowingDetail>{listItems}</List>;
}

const CurrentRecordingDetail: React.FC<{ currentRecording: Recording }> = ({ currentRecording }) => {
  const status = useStore(currentRecording.$status);
  const recorder = currentRecording.recorder ?? nullRecorder;
  const duration = useStore(recorder.$duration);
  const levels = useStore(recorder.$levels);
  return (
    <List.Item.Detail
      markdown={`# ${status}`}
      metadata={
        <List.Item.Detail.Metadata>
          <List.Item.Detail.Metadata.Label title="Duration" text={duration} />
          <List.Item.Detail.Metadata.Label title="Sound Level" text={levels} />
        </List.Item.Detail.Metadata>
      }
    />
  );
};

const StoppedRecordingDetail: React.FC<{ recording: Recording }> = ({ recording }) => {
  const transcription = useStore(recording.$transcription);
  const getTranscriptionMarkdown = (transcription: TranscriptionState) => {
    let text = transcription.transcription;
    if (!transcription.finished) {
      if (transcription.latestThought && !text) {
        text += `*${transcription.latestThought}...*`;
      } else {
        text += "...";
      }
    }
    if (transcription.error) {
      text += `\n\nError: ${transcription.error}`;
    }
    return text;
  };

  return (
    <List.Item.Detail
      isLoading={!transcription?.finished}
      markdown={transcription ? getTranscriptionMarkdown(transcription) : `No transcription`}
      metadata={
        transcription && (
          <List.Item.Detail.Metadata>
            {transcription.audioLengthSeconds && (
              <List.Item.Detail.Metadata.Label
                title="Audio Length"
                text={`${transcription.audioLengthSeconds.toFixed(1)}s`}
              />
            )}
            {transcription.inputTokens && (
              <List.Item.Detail.Metadata.Label title="Input Tokens" text={transcription.inputTokens.toString()} />
            )}
            {transcription.thoughtsTokens && (
              <List.Item.Detail.Metadata.Label title="Thoughts Tokens" text={transcription.thoughtsTokens.toString()} />
            )}
            {transcription.outputTokens && (
              <List.Item.Detail.Metadata.Label title="Output Tokens" text={transcription.outputTokens.toString()} />
            )}
          </List.Item.Detail.Metadata>
        )
      }
    />
  );
};

const StoppedRecordingActions: React.FC<{ recording: Recording; onDelete: () => void }> = ({ recording, onDelete }) => {
  const transcription = useStore(recording.$transcription);
  const textToCopy = String(transcription?.transcription || "No transcription").trim();
  const { default_action } = getPreferenceValues<{ gemini_api_key: string; default_action: string }>();

  const isTypeFirst = default_action !== "copy";
  const decapitalizedText = textToCopy.charAt(0).toLowerCase() + textToCopy.slice(1);

  const typeActions = [
    <Action.Paste key="type" title="Type" content={textToCopy} shortcut={undefined} />,
    <Action.Paste
      key="type-decap"
      title="Type (Decapitalized)"
      content={decapitalizedText}
      shortcut={isTypeFirst ? { modifiers: ["shift"], key: "return" } : { modifiers: ["cmd", "shift"], key: "return" }}
    />,
  ];

  const copyActions = [
    <Action.CopyToClipboard key="copy" title="Copy" content={textToCopy} shortcut={{ modifiers: ["cmd"], key: "c" }} />,
    <Action.CopyToClipboard
      key="copy-decap"
      title="Copy (Decapitalized)"
      content={decapitalizedText}
      shortcut={isTypeFirst ? { modifiers: ["cmd", "shift"], key: "return" } : { modifiers: ["shift"], key: "return" }}
    />,
  ];

  const actions: React.ReactNode[] = [];

  // Note: The first action becomes the "primary action" and the 2nd action becomes the "secondary action".
  // The first action gets ↵ and the 2nd action gets ⌘↵ by default.
  if (isTypeFirst) {
    actions.push(typeActions.shift(), copyActions.shift(), ...typeActions, ...copyActions);
  } else {
    actions.push(copyActions.shift(), typeActions.shift(), ...copyActions, ...typeActions);
  }

  actions.push(
    <Action
      key="retry"
      title="Retry"
      icon={Icon.Repeat}
      onAction={() => {
        recording.transcribe();
      }}
      shortcut={{ modifiers: ["cmd"], key: "r" }}
    />,
    <Action
      key="delete"
      title="Delete"
      icon={Icon.Trash}
      onAction={onDelete}
      shortcut={{ modifiers: ["cmd"], key: "backspace" }}
    />,
    <Action.ShowInFinder
      key="show-finder"
      title="Show in Finder"
      path={recording.mp3Path}
      shortcut={{ modifiers: ["cmd"], key: "o" }}
    />,
  );

  return <ActionPanel>{actions}</ActionPanel>;
};

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}
