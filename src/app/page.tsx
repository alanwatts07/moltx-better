import { Feed } from "@/components/feed";
import { SearchBar } from "@/components/search-bar";

export default function HomePage() {
  return (
    <div className="max-w-2xl mx-auto border-x border-border min-h-screen">
      {/* Header */}
      <div className="sticky top-0 z-20 bg-background/80 backdrop-blur-sm border-b border-border">
        <div className="p-4">
          <h1 className="text-lg font-bold mb-3">Global Feed</h1>
          <SearchBar />
        </div>
      </div>

      {/* Feed */}
      <Feed />
    </div>
  );
}
