"use client";

import React, { useState, useEffect, useRef } from "react";
import { VChart } from "@visactor/react-vchart";
import { Mic, MicOff, Search, Loader2, Upload, Database } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function GenVizApp() {
  const [query, setQuery] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  
  // Custom DB State
  const [showSettings, setShowSettings] = useState(false);
  const [dbUrl, setDbUrl] = useState("");

  const recognitionRef = useRef<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Load saved DB URL
    if (typeof window !== "undefined") {
      const savedUrl = localStorage.getItem("genviz_db_url");
      if (savedUrl) setDbUrl(savedUrl);
      
      const SpeechRecognition =
        (window as any).SpeechRecognition ||
        (window as any).webkitSpeechRecognition;
      if (SpeechRecognition) {
        recognitionRef.current = new SpeechRecognition();
        recognitionRef.current.continuous = false;
        recognitionRef.current.interimResults = true;
        
        recognitionRef.current.onresult = (event: any) => {
          const transcript = event.results[0][0].transcript;
          setQuery(transcript);
        };
        
        recognitionRef.current.onerror = (event: any) => {
          console.error("Speech recognition error", event.error);
          setIsListening(false);
        };
        
        recognitionRef.current.onend = () => {
          setIsListening(false);
        };
      } else {
        console.warn("Speech recognition not supported in this browser.");
      }
    }
  }, []);

  const saveDbUrl = (url: string) => {
    setDbUrl(url);
    if (typeof window !== "undefined") {
      localStorage.setItem("genviz_db_url", url);
    }
  };

  const clearDbUrl = () => {
    setDbUrl("");
    if (typeof window !== "undefined") {
      localStorage.removeItem("genviz_db_url");
    }
  };

  const toggleListen = () => {
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
    } else {
      recognitionRef.current?.start();
      setIsListening(true);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setError(null);
    setUploadMessage(null);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "File upload failed");
      }

      setUploadMessage(data.message);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleRunQuery = async () => {
    if (!query.trim()) return;
    
    setLoading(true);
    setError(null);
    setResult(null);
    setUploadMessage(null);
    
    try {
      const res = await fetch("/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          question: query,
          customDatabaseUrl: dbUrl || undefined
        }),
      });
      
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to fetch");
      }
      
      setResult(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-full max-w-5xl mx-auto p-4 space-y-6">
      
      {showSettings && (
        <div className="p-6 bg-card rounded-xl border shadow-sm mb-6 animate-in fade-in slide-in-from-top-4">
          <h3 className="text-lg font-semibold mb-2">Connect Remote Database</h3>
          <p className="text-sm text-muted-foreground mb-4">
            Enter a PostgreSQL connection string to query your live data instead of local CSVs.
          </p>
          <div className="flex gap-2">
            <input 
              type="text" 
              className="flex-1 p-3 rounded-lg border bg-background text-sm"
              placeholder="postgresql://user:password@localhost:5432/mydb"
              value={dbUrl}
              onChange={(e) => saveDbUrl(e.target.value)}
            />
            <Button variant="outline" onClick={clearDbUrl}>Clear</Button>
            <Button onClick={() => setShowSettings(false)}>Done</Button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[300px]">
          <input
            type="text"
            className="w-full p-4 pl-12 rounded-xl border bg-background text-foreground shadow-sm focus:ring-2 focus:ring-primary outline-none"
            placeholder="Ask a question about your data..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleRunQuery()}
            disabled={loading}
          />
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground w-5 h-5" />
        </div>
        
        {/* Database Toggle */}
        <Button
          type="button"
          variant={showSettings ? "default" : "outline"}
          size="icon"
          className="h-14 w-14 rounded-xl flex-shrink-0"
          onClick={() => setShowSettings((prev) => !prev)}
          title="Database Settings"
        >
          <Database className="w-5 h-5 pointer-events-none" />
        </Button>

        {/* File Upload (Hidden Input with Custom Button Proxy) */}
        <input 
          type="file" 
          id="csv-upload"
          accept=".csv" 
          ref={fileInputRef}
          className="w-0 h-0 absolute opacity-0 pointer-events-none"
          tabIndex={-1}
          onChange={(e) => {
            if (dbUrl) {
               setError("⚠️ You are currently connected to a Custom Database (PostgreSQL). Please click the Database icon and CLEAR your connection before uploading a local CSV.");
               if (fileInputRef.current) fileInputRef.current.value = "";
               return;
            }
            if (e.target.files && e.target.files.length > 0) {
              handleFileUpload(e);
            }
          }} 
          disabled={loading}
        />
        
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-14 w-14 rounded-xl flex-shrink-0"
          onClick={() => fileInputRef.current?.click()}
          disabled={loading}
          title="Upload CSV Data"
        >
          <Upload className="w-5 h-5" />
        </Button>

        {/* Voice Command */}
        <Button
          type="button"
          variant={isListening ? "destructive" : "secondary"}
          size="icon"
          className="h-14 w-14 rounded-xl flex-shrink-0"
          onClick={toggleListen}
          disabled={loading}
          title="Voice Command"
        >
          {isListening ? <MicOff className="w-6 h-6 pointer-events-none" /> : <Mic className="w-6 h-6 pointer-events-none" />}
        </Button>

        {/* Submit */}
        <Button 
          type="button"
          onClick={handleRunQuery} 
          disabled={loading || !query.trim()}
          className="h-14 px-8 rounded-xl flex-shrink-0"
        >
          {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : "Generate"}
        </Button>
      </div>

      {uploadMessage && (
        <div className="p-4 bg-primary/10 text-primary rounded-xl border border-primary/20">
          <strong>Success: </strong> {uploadMessage}
        </div>
      )}

      {error && (
        <div className="p-4 bg-destructive/10 text-destructive rounded-xl border border-destructive/20">
          <strong>Error: </strong> {error}
        </div>
      )}

      {result && (
        <div className="space-y-6">
          <div className="p-4 bg-card rounded-xl border shadow-sm">
            <h3 className="font-semibold mb-2 text-sm text-muted-foreground">Generated SQL (Gemini)</h3>
            <pre className="p-4 bg-muted rounded-lg overflow-x-auto text-sm font-mono">
              {result.sql}
            </pre>
          </div>
          
          <div className="p-6 bg-card rounded-xl border shadow-sm min-h-[400px]">
            {result.chart?.type === "table" || result.chart?.type === "empty" ? (
              <div className="w-full overflow-auto">
                {result.chart.type === "empty" ? (
                  <p className="text-muted-foreground text-center py-10">{result.chart.message}</p>
                ) : (
                  <table className="w-full text-left bg-muted/50 rounded-lg overflow-hidden">
                    <thead className="bg-muted">
                      <tr>
                        {Object.keys(result.chart.data[0] || {}).map(k => (
                          <th key={k} className="p-3 font-medium text-sm text-muted-foreground uppercase">{k}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                       {result.chart.data.map((row: any, i: number) => (
                         <tr key={i}>
                           {Object.values(row).map((val: any, j: number) => (
                             <td key={j} className="p-3 text-sm">{String(val)}</td>
                           ))}
                         </tr>
                       ))}
                    </tbody>
                  </table>
                )}
              </div>
            ) : (
              <div className="w-full h-full min-h-[400px]">
                {/* Dynamically render VChart via its spec payload mapping */}
                <ClientVChart spec={result.chart?.spec} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Ensure VChart only mounts client side to prevent hydration mismatches
function ClientVChart({ spec }: { spec: any }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted || !spec) return <div className="animate-pulse bg-muted w-full h-full min-h-[400px] rounded-lg" />;
  
  return <VChart spec={spec} className="w-full h-full min-h-[400px]" />;
}
