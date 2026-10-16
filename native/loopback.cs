// Captures what the default playback devices are playing (WASAPI loopback):
// the regular default output and, if different, the communication device
// that call apps use. Mixes them,
// downmixes to mono, resamples to 16 kHz and writes float32 PCM to stdout.
// Works with any channel layout (stereo, 7.1 headsets, ...).
//
// Exit codes: 0 stdout closed, 2 device error, 3 default device changed
// (the caller restarts it to follow the new device).
//
// Built at runtime by src/loopback.js with the .NET Framework csc.exe.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

static class Loopback
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorCom { }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        int OpenPropertyStore(int access, out IntPtr store);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    }

    [Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
        int GetBufferSize(out int frames);
        int GetStreamLatency(out long latency);
        int GetCurrentPadding(out int padding);
        int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
        int GetMixFormat(out IntPtr format);
        int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        int Start();
        int Stop();
        int Reset();
        int SetEventHandle(IntPtr handle);
        int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        int GetBuffer(out IntPtr data, out int frames, out int flags, out long devicePosition, out long qpcPosition);
        int ReleaseBuffer(int frames);
        int GetNextPacketSize(out int frames);
    }

    const int AUDCLNT_SHAREMODE_SHARED = 0;
    const int AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    const int AUDCLNT_BUFFERFLAGS_SILENT = 0x2;
    const int CLSCTX_ALL = 23;
    const int OUT_RATE = 16000;

    const int ROLE_CONSOLE = 0;        // Windows "Default Device"
    const int ROLE_COMMUNICATIONS = 2; // "Default Communication Device" (calls in Skype, Teams, Discord...)

    static IMMDevice DefaultRender(IMMDeviceEnumerator en, int role, out string id)
    {
        IMMDevice dev;
        Check(en.GetDefaultAudioEndpoint(0 /* eRender */, role, out dev), "GetDefaultAudioEndpoint");
        dev.GetId(out id);
        return dev;
    }

    static void Check(int hr, string what)
    {
        if (hr != 0) throw new Exception(what + " failed: 0x" + hr.ToString("X8"));
    }

    static int Main(string[] args)
    {
        try { return Run(Array.IndexOf(args, "--test-dual") >= 0); }
        catch (IOException) { return 0; } // parent closed the pipe
        catch (Exception ex)
        {
            Console.Error.WriteLine("error: " + ex.Message);
            return 2;
        }
    }

    // Loopback capture of one output device, converted to 16 kHz mono and
    // queued. Time with no packets (nothing playing) is filled with silence,
    // so every device's queue advances in step with the wall clock.
    class DeviceCapture
    {
        public string Id;
        public string Description;
        IAudioCaptureClient capture;
        int channels, bits, blockAlign;
        bool isFloat;
        double step, phase, acc;
        int accN;
        long produced;
        public readonly System.Collections.Generic.List<float> Queue = new System.Collections.Generic.List<float>();

        public DeviceCapture(IMMDevice device, string id)
        {
            Id = id;
            Guid iidClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
            object o;
            Check(device.Activate(ref iidClient, CLSCTX_ALL, IntPtr.Zero, out o), "Activate");
            var client = (IAudioClient)o;

            IntPtr fmt;
            Check(client.GetMixFormat(out fmt), "GetMixFormat");
            int tag = (ushort)Marshal.ReadInt16(fmt, 0);
            channels = Marshal.ReadInt16(fmt, 2);
            int rate = Marshal.ReadInt32(fmt, 4);
            blockAlign = Marshal.ReadInt16(fmt, 12);
            bits = Marshal.ReadInt16(fmt, 14);
            isFloat = tag == 3 || (tag == 0xFFFE && Marshal.ReadInt32(fmt, 24) == 3);
            step = (double)rate / OUT_RATE;

            Check(client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 2000000 /* 200 ms */, 0, fmt, IntPtr.Zero), "Initialize");
            Guid iidCapture = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
            Check(client.GetService(ref iidCapture, out o), "GetService");
            capture = (IAudioCaptureClient)o;
            Check(client.Start(), "Start");
            Description = channels + "ch " + rate + "Hz " + bits + "bit " + (isFloat ? "float" : "pcm");
        }

        // Read everything available; pad with silence up to `expected` samples
        // if nothing was playing.
        public void Poll(long expected)
        {
            bool gotData = false;
            int packet;
            Check(capture.GetNextPacketSize(out packet), "GetNextPacketSize");
            while (packet > 0)
            {
                IntPtr data; int frames; int flags; long pos; long qpc;
                Check(capture.GetBuffer(out data, out frames, out flags, out pos, out qpc), "GetBuffer");
                bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
                for (int f = 0; f < frames; f++)
                {
                    double sum = 0;
                    if (!silent)
                    {
                        IntPtr frame = IntPtr.Add(data, f * blockAlign);
                        for (int c = 0; c < channels; c++) sum += ReadSample(frame, c, bits, isFloat);
                    }
                    // Box-filter decimation to 16 kHz: average the input
                    // samples that fall into each output sample's window.
                    acc += sum / channels;
                    accN++;
                    phase += 1;
                    if (phase >= step)
                    {
                        phase -= step;
                        Queue.Add((float)(acc / accN));
                        produced++;
                        acc = 0;
                        accN = 0;
                    }
                }
                Check(capture.ReleaseBuffer(frames), "ReleaseBuffer");
                gotData = true;
                Check(capture.GetNextPacketSize(out packet), "GetNextPacketSize");
            }
            if (!gotData && expected - produced > OUT_RATE / 20)
            {
                for (long i = produced; i < expected; i++) Queue.Add(0f);
                produced = expected;
            }
        }
    }

    // testDual: capture the default device twice, to exercise the mixing path.
    static int Run(bool testDual)
    {
        var en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
        string consoleId, commsId;
        IMMDevice consoleDev = DefaultRender(en, ROLE_CONSOLE, out consoleId);
        IMMDevice commsDev = DefaultRender(en, ROLE_COMMUNICATIONS, out commsId);

        // Capture the regular default output, plus the call output when it's
        // a different device; their audio is mixed together.
        var captures = new System.Collections.Generic.List<DeviceCapture>();
        captures.Add(new DeviceCapture(consoleDev, consoleId));
        if (commsId != consoleId) captures.Add(new DeviceCapture(commsDev, commsId));
        else if (testDual) captures.Add(new DeviceCapture(DefaultRender(en, ROLE_CONSOLE, out consoleId), consoleId));

        var desc = new System.Text.StringBuilder();
        foreach (var c in captures) desc.Append(desc.Length > 0 ? " + " : "").Append(c.Description);
        Console.Error.WriteLine("format: " + desc + (captures.Count > 1 ? " (default + communication device)" : ""));
        Console.Error.Flush();

        Stream stdout = Console.OpenStandardOutput();
        var outBuf = new MemoryStream();
        var writer = new BinaryWriter(outBuf);
        var clock = Stopwatch.StartNew();
        long lastDeviceCheck = 0;

        while (true)
        {
            long expected = (long)(clock.Elapsed.TotalSeconds * OUT_RATE);
            foreach (var c in captures) c.Poll(expected);

            // Mix what every device has produced so far.
            int n = int.MaxValue;
            foreach (var c in captures) n = Math.Min(n, c.Queue.Count);
            for (int i = 0; i < n; i++)
            {
                float sum = 0;
                foreach (var c in captures) sum += c.Queue[i];
                writer.Write(Math.Max(-1f, Math.Min(1f, sum)));
            }
            foreach (var c in captures)
            {
                c.Queue.RemoveRange(0, n);
                // A device far ahead of the others (clock drift): drop its excess.
                if (c.Queue.Count > OUT_RATE) c.Queue.RemoveRange(0, c.Queue.Count - OUT_RATE / 10);
            }

            if (outBuf.Length > 0)
            {
                writer.Flush();
                stdout.Write(outBuf.GetBuffer(), 0, (int)outBuf.Length);
                stdout.Flush();
                outBuf.SetLength(0);
            }

            // Follow the default devices: exit so the caller restarts on the new ones.
            if (clock.ElapsedMilliseconds - lastDeviceCheck > 1000)
            {
                lastDeviceCheck = clock.ElapsedMilliseconds;
                string nowConsole, nowComms;
                DefaultRender(en, ROLE_CONSOLE, out nowConsole);
                DefaultRender(en, ROLE_COMMUNICATIONS, out nowComms);
                if (nowConsole != consoleId || nowComms != commsId)
                {
                    Console.Error.WriteLine("default device changed");
                    return 3;
                }
            }

            Thread.Sleep(10);
        }
    }

    static double ReadSample(IntPtr frame, int channel, int bits, bool isFloat)
    {
        if (isFloat && bits == 32)
        {
            int raw = Marshal.ReadInt32(frame, channel * 4);
            return BitConverter.ToSingle(BitConverter.GetBytes(raw), 0);
        }
        switch (bits)
        {
            case 16: return Marshal.ReadInt16(frame, channel * 2) / 32768.0;
            case 24:
            {
                int off = channel * 3;
                int v = Marshal.ReadByte(frame, off) | (Marshal.ReadByte(frame, off + 1) << 8) | ((sbyte)Marshal.ReadByte(frame, off + 2) << 16);
                return v / 8388608.0;
            }
            case 32: return Marshal.ReadInt32(frame, channel * 4) / 2147483648.0;
            default: return 0;
        }
    }
}
