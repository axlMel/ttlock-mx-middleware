declare const releaseContents: {
  releaseEntries(): string[];
  nativeModules(directory: string): Promise<string[]>;
};

export = releaseContents;
