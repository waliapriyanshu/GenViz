import GenVizApp from "@/components/genviz-app";

export default function Home() {
  return (
    <div className="min-h-screen bg-background text-foreground py-10 px-4 md:px-8">
      <div className="max-w-6xl mx-auto mb-10 text-center">
        <h1 className="text-4xl font-bold tracking-tight mb-2">GenViz Analytics</h1>
        <p className="text-muted-foreground">Ask questions via Voice or Text, and get instant SQL and VisActor insights.</p>
      </div>
      
      <GenVizApp />
    </div>
  );
}
