// Reads mono float32 little-endian PCM from stdin and prints libkeyfinder's key as "<pitch class 0-11> <major|minor>"
// (pitch class 0 = C), or "silence". Usage: keyfinder-pcm <sample rate>
#include <keyfinder/keyfinder.h>
#include <cstdio>
#include <cstdlib>
#include <vector>

int main(int argc, char** argv) {
  if (argc != 2) {
    std::fprintf(stderr, "usage: keyfinder-pcm <sample rate> < mono-f32le.pcm\n");
    return 2;
  }
  std::vector<float> buf;
  float chunk[65536];
  size_t n;
  while ((n = std::fread(chunk, sizeof(float), 65536, stdin)) > 0) buf.insert(buf.end(), chunk, chunk + n);

  KeyFinder::AudioData audio;
  audio.setFrameRate(static_cast<unsigned int>(std::atoi(argv[1])));
  audio.setChannels(1);
  audio.addToSampleCount(buf.size());
  for (size_t i = 0; i < buf.size(); i++) audio.setSample(i, buf[i]);

  KeyFinder::KeyFinder finder;
  KeyFinder::key_t key = finder.keyOfAudio(audio);
  if (key == KeyFinder::SILENCE) {
    std::puts("silence");
    return 0;
  }
  // The enum runs A major, A minor, B♭ major, ... in semitone steps from A, major before minor.
  int fromA = static_cast<int>(key) / 2;
  bool minor = static_cast<int>(key) % 2 == 1;
  std::printf("%d %s\n", (fromA + 9) % 12, minor ? "minor" : "major");
  return 0;
}
