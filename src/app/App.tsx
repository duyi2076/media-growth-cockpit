import { lazy, Suspense } from "react";
import { Navigate, Routes, Route } from "react-router-dom";
import { AppLayout } from "./layout/AppLayout";
import { GrowthPage } from "./pages/GrowthPage";
import { ContentPage } from "./pages/ContentPage";
import { KnowledgePage } from "./pages/KnowledgePage";
import { ReviewsPage } from "./pages/ReviewsPage";
import { DailyReviewsPage } from "./pages/DailyReviewsPage";

const AiCollaborationPage = lazy(async () => {
  const module = await import("./pages/AiCollaborationPage");
  return { default: module.AiCollaborationPage };
});

export function App() {
  return (
    <Routes>
      <Route path="/" element={<AppLayout />}>
      <Route index element={<GrowthPage />} />
      <Route path="content" element={<ContentPage />} />
      <Route path="knowledge" element={<KnowledgePage />} />
      <Route path="reviews" element={<ReviewsPage />} />
      <Route path="daily-reviews" element={<DailyReviewsPage />} />
      <Route path="ai" element={(
        <Suspense fallback={<div className="ai-route-loading" role="status">正在载入 AI 协作…</div>}>
          <AiCollaborationPage />
        </Suspense>
      )} />
      <Route path="tasks" element={<Navigate to="/content" replace />} />
      <Route path="topics" element={<Navigate to="/content" replace />} />
      <Route path="materials" element={<Navigate to="/knowledge" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
