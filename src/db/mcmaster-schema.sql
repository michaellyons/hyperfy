-- McMaster Museum CMS Database Schema
-- Run: psql -d mcmaster_museum -f src/db/schema.sql

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- For fuzzy text search

-- ============================================================================
-- CATEGORIES (Hierarchical taxonomy)
-- ============================================================================

CREATE TABLE categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  parent_id UUID REFERENCES categories(id) ON DELETE SET NULL,
  
  -- Museum display config
  display_order INTEGER DEFAULT 0,
  theme_color VARCHAR(7) DEFAULT '#d4af37', -- Gold default
  icon VARCHAR(50),
  
  -- External refs
  mcmaster_category_id VARCHAR(50),
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_categories_parent ON categories(parent_id);
CREATE INDEX idx_categories_slug ON categories(slug);
CREATE INDEX idx_categories_display ON categories(display_order);

-- Root categories
INSERT INTO categories (name, slug, description, theme_color, display_order) VALUES
  ('Fasteners', 'fasteners', 'Screws, bolts, nuts, and washers', '#c9a227', 1),
  ('Bearings', 'bearings', 'Ball bearings, roller bearings, and bushings', '#b87333', 2),
  ('Fittings', 'fittings', 'Hose, tube, and pipe fittings', '#708090', 3),
  ('Electrical', 'electrical', 'Connectors, wire, and electrical components', '#ffd700', 4),
  ('Raw Materials', 'raw-materials', 'Metal stock, plastics, and raw material', '#a9a9a9', 5),
  ('Tools', 'tools', 'Hand tools, power tools, and measuring instruments', '#cd853f', 6),
  ('Motors & Motion', 'motors-motion', 'Motors, gears, belts, and motion control', '#4169e1', 7);

-- ============================================================================
-- ASSETS (The main 3D object catalog)
-- ============================================================================

CREATE TABLE assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Identification
  part_number VARCHAR(50) UNIQUE,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) UNIQUE,
  description TEXT,
  short_description VARCHAR(500),
  
  -- Categorization
  category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
  tags TEXT[] DEFAULT '{}',
  
  -- Asset type & source
  asset_type VARCHAR(50) NOT NULL DEFAULT 'product' 
    CHECK (asset_type IN ('product', 'tool', 'component', 'assembly', 'educational', 'generated', 'scanned')),
  source VARCHAR(50) NOT NULL DEFAULT 'manual_upload'
    CHECK (source IN ('mcmaster', 'manual_upload', 'ai_generated', 'cad_import', 'scan', 'community')),
  
  -- 3D Model files
  model_format VARCHAR(10) CHECK (model_format IN ('step', 'stl', 'obj', 'glb', 'gltf', 'fbx', '3mf')),
  model_url TEXT,
  model_size_bytes BIGINT,
  model_quality_score DECIMAL(3,2), -- AI/ML quality assessment
  
  -- Preview media
  thumbnail_url TEXT,
  preview_images JSONB DEFAULT '[]', -- [{url, type, caption}]
  
  -- Technical specifications (flexible JSON)
  specifications JSONB DEFAULT '{}',
  dimensions JSONB, -- {x: 10.5, y: 20.0, z: 5.2, unit: 'mm'}
  material VARCHAR(100),
  material_properties JSONB, -- {density, hardness, conductivity}
  weight_g DECIMAL(10,2),
  
  -- AI Generation metadata
  ai_generation_id UUID,
  generation_prompt TEXT,
  generation_parameters JSONB,
  
  -- Status & versioning
  status VARCHAR(20) DEFAULT 'draft' 
    CHECK (status IN ('draft', 'published', 'archived', 'deprecated')),
  version INTEGER DEFAULT 1,
  parent_asset_id UUID REFERENCES assets(id) ON DELETE SET NULL,
  is_latest_version BOOLEAN DEFAULT true,
  
  -- Analytics
  view_count INTEGER DEFAULT 0,
  download_count INTEGER DEFAULT 0,
  
  -- Ownership
  created_by VARCHAR(255),
  updated_by VARCHAR(255),
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  published_at TIMESTAMP WITH TIME ZONE,
  
  -- Full-text search vector
  search_vector tsvector
);

-- Indexes
CREATE INDEX idx_assets_category ON assets(category_id);
CREATE INDEX idx_assets_status ON assets(status) WHERE status = 'published';
CREATE INDEX idx_assets_type ON assets(asset_type);
CREATE INDEX idx_assets_source ON assets(source);
CREATE INDEX idx_assets_search ON assets USING GIN(search_vector);
CREATE INDEX idx_assets_tags ON assets USING GIN(tags);
CREATE INDEX idx_assets_part_number ON assets(part_number) WHERE part_number IS NOT NULL;
CREATE INDEX idx_assets_latest ON assets(parent_asset_id, is_latest_version);

-- Full-text search trigger
CREATE OR REPLACE FUNCTION assets_search_vector_update()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector := 
    setweight(to_tsvector('english', COALESCE(NEW.name, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(NEW.short_description, '')), 'C') ||
    setweight(to_tsvector('english', COALESCE(array_to_string(NEW.tags, ' '), '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER assets_search_update
  BEFORE INSERT OR UPDATE ON assets
  FOR EACH ROW
  EXECUTE FUNCTION assets_search_vector_update();

-- Slug generation trigger
CREATE OR REPLACE FUNCTION assets_slug_generate()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.slug IS NULL THEN
    NEW.slug := lower(regexp_replace(NEW.name, '[^a-zA-Z0-9]+', '-', 'g')) || '-' || substr(NEW.id::text, 1, 8);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER assets_slug_insert
  BEFORE INSERT ON assets
  FOR EACH ROW
  EXECUTE FUNCTION assets_slug_generate();

-- ============================================================================
-- AI GENERATIONS (Track AI model creation)
-- ============================================================================

CREATE TABLE ai_generations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Request details
  provider VARCHAR(50) NOT NULL CHECK (provider IN ('tripo3d', 'meshy', 'shap-e', 'sloyd', 'luma', 'rodin')),
  prompt TEXT NOT NULL,
  negative_prompt TEXT,
  reference_image_url TEXT,
  reference_asset_id UUID REFERENCES assets(id) ON DELETE SET NULL,
  
  -- Generation parameters
  style VARCHAR(50) DEFAULT 'technical' CHECK (style IN ('technical', 'realistic', 'stylized', 'exploded', 'museum', 'schematic')),
  seed INTEGER,
  guidance_scale DECIMAL(3,1) DEFAULT 7.5,
  
  -- Status tracking
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'queued', 'processing', 'completed', 'failed', 'cancelled')),
  progress_percent INTEGER DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  
  -- Results
  result_model_url TEXT,
  result_thumbnail_url TEXT,
  result_formats JSONB DEFAULT '[]', -- ['step', 'glb', 'obj']
  
  -- Error handling
  error_code VARCHAR(50),
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  
  -- Metadata
  credits_used DECIMAL(10,4),
  processing_time_ms INTEGER,
  
  -- Review workflow
  review_status VARCHAR(20) DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'rejected', 'needs_revision')),
  reviewed_by VARCHAR(255),
  reviewed_at TIMESTAMP WITH TIME ZONE,
  review_notes TEXT,
  
  -- Resulting asset
  generated_asset_id UUID REFERENCES assets(id) ON DELETE SET NULL,
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,
  created_by VARCHAR(255) DEFAULT 'system'
);

CREATE INDEX idx_ai_generations_status ON ai_generations(status);
CREATE INDEX idx_ai_generations_provider ON ai_generations(provider);
CREATE INDEX idx_ai_generations_review ON ai_generations(review_status) WHERE review_status != 'approved';
CREATE INDEX idx_ai_generations_created ON ai_generations(created_at DESC);

-- Foreign key to link back to assets
ALTER TABLE assets ADD CONSTRAINT fk_ai_generation 
  FOREIGN KEY (ai_generation_id) REFERENCES ai_generations(id) ON DELETE SET NULL;

-- ============================================================================
-- LEARNING MATERIALS (Educational content attached to assets)
-- ============================================================================

CREATE TABLE learning_materials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id UUID REFERENCES assets(id) ON DELETE CASCADE,
  
  -- Content details
  title VARCHAR(255) NOT NULL,
  slug VARCHAR(255) UNIQUE,
  content_type VARCHAR(50) NOT NULL 
    CHECK (content_type IN ('article', 'video', 'interactive', 'quiz', 'diagram', 'spec_sheet', 'tutorial', 'ar_experience', 'comparison')),
  
  -- Content body
  content TEXT, -- Markdown/HTML
  content_json JSONB, -- Structured content for interactive types
  content_url TEXT, -- External embed URL
  
  -- Media
  media_assets JSONB DEFAULT '[]', -- [{type, url, caption, order}]
  
  -- Pedagogy
  difficulty_level INTEGER CHECK (difficulty_level BETWEEN 1 AND 5),
  estimated_minutes INTEGER,
  learning_objectives TEXT[], -- ["Understand thread pitch", "Identify drive types"]
  prerequisites UUID[], -- Array of learning_material IDs
  
  -- Engagement
  view_count INTEGER DEFAULT 0,
  completion_count INTEGER DEFAULT 0,
  avg_rating DECIMAL(2,1),
  rating_count INTEGER DEFAULT 0,
  
  -- Discoverability
  tags TEXT[] DEFAULT '{}',
  keywords TEXT[] DEFAULT '{}',
  
  -- Status
  status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  
  created_by VARCHAR(255),
  updated_by VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  published_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_learning_asset ON learning_materials(asset_id);
CREATE INDEX idx_learning_type ON learning_materials(content_type);
CREATE INDEX idx_learning_status ON learning_materials(status) WHERE status = 'published';
CREATE INDEX idx_learning_difficulty ON learning_materials(difficulty_level);

-- ============================================================================
-- ASSET RELATIONSHIPS (Graph connections)
-- ============================================================================

CREATE TABLE asset_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  to_asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  
  relationship_type VARCHAR(50) NOT NULL 
    CHECK (relationship_type IN ('contains', 'requires', 'replaces', 'compatible_with', 'similar_to', 'derived_from', 'assembly_of', 'alternative_to')),
  
  strength DECIMAL(3,2) DEFAULT 1.0 CHECK (strength BETWEEN 0.0 AND 1.0), -- For ML recommendations
  
  metadata JSONB DEFAULT '{}', -- {confidence, source, notes}
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  UNIQUE(from_asset_id, to_asset_id, relationship_type)
);

CREATE INDEX idx_rel_from ON asset_relationships(from_asset_id);
CREATE INDEX idx_rel_to ON asset_relationships(to_asset_id);
CREATE INDEX idx_rel_type ON asset_relationships(relationship_type);

-- ============================================================================
-- USER COLLECTIONS (Personal/group asset playlists)
-- ============================================================================

CREATE TABLE collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255) NOT NULL,
  
  name VARCHAR(255) NOT NULL,
  description TEXT,
  slug VARCHAR(255),
  
  -- Display
  cover_image_url TEXT,
  theme_color VARCHAR(7),
  
  -- Settings
  is_public BOOLEAN DEFAULT false,
  allow_comments BOOLEAN DEFAULT true,
  
  -- Stats
  view_count INTEGER DEFAULT 0,
  like_count INTEGER DEFAULT 0,
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_collections_user ON collections(user_id);
CREATE INDEX idx_collections_public ON collections(is_public) WHERE is_public = true;

CREATE TABLE collection_assets (
  collection_id UUID REFERENCES collections(id) ON DELETE CASCADE,
  asset_id UUID REFERENCES assets(id) ON DELETE CASCADE,
  
  display_order INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  added_by VARCHAR(255),
  added_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  PRIMARY KEY (collection_id, asset_id)
);

CREATE INDEX idx_collection_assets_order ON collection_assets(collection_id, display_order);

-- ============================================================================
-- USER PROGRESS (Learning tracking)
-- ============================================================================

CREATE TABLE user_progress (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255) NOT NULL,
  
  material_id UUID REFERENCES learning_materials(id) ON DELETE CASCADE,
  asset_id UUID REFERENCES assets(id) ON DELETE CASCADE, -- Redundant but useful
  
  -- Progress
  status VARCHAR(20) DEFAULT 'started' CHECK (status IN ('started', 'in_progress', 'completed', 'abandoned')),
  progress_percent INTEGER DEFAULT 0,
  
  -- Engagement
  time_spent_seconds INTEGER DEFAULT 0,
  interactions_count INTEGER DEFAULT 0, -- Clicks, scrolls, etc.
  
  -- Quiz results (if applicable)
  quiz_score DECIMAL(5,2),
  quiz_answers JSONB,
  
  -- Timestamps
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,
  last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  UNIQUE(user_id, material_id)
);

CREATE INDEX idx_progress_user ON user_progress(user_id);
CREATE INDEX idx_progress_material ON user_progress(material_id);
CREATE INDEX idx_progress_status ON user_progress(status);

-- ============================================================================
-- VECTOR EMBEDDINGS (For semantic search - requires pgvector extension)
-- ============================================================================

-- Note: Install with: CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS asset_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id UUID UNIQUE REFERENCES assets(id) ON DELETE CASCADE,
  
  -- OpenAI text-embedding-3-small = 1536 dimensions
  -- text-embedding-3-large = 3072 dimensions
  embedding vector(1536),
  
  -- Source text that was embedded (for debugging)
  source_text TEXT,
  
  model VARCHAR(50) DEFAULT 'text-embedding-3-small',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_asset_embeddings ON asset_embeddings USING ivfflat (embedding vector_cosine_ops);

-- ============================================================================
-- AUDIT LOG (Track all changes)
-- ============================================================================

CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  table_name VARCHAR(50) NOT NULL,
  record_id UUID NOT NULL,
  action VARCHAR(20) NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
  
  old_values JSONB,
  new_values JSONB,
  
  changed_by VARCHAR(255),
  changed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  ip_address INET,
  user_agent TEXT
);

CREATE INDEX idx_audit_table ON audit_log(table_name, record_id);
CREATE INDEX idx_audit_changed_at ON audit_log(changed_at DESC);

-- ============================================================================
-- UPDATED AT TRIGGERS
-- ============================================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to all tables with updated_at
CREATE TRIGGER update_categories_updated_at BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  
CREATE TRIGGER update_assets_updated_at BEFORE UPDATE ON assets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  
CREATE TRIGGER update_ai_generations_updated_at BEFORE UPDATE ON ai_generations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  
CREATE TRIGGER update_learning_materials_updated_at BEFORE UPDATE ON learning_materials
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  
CREATE TRIGGER update_collections_updated_at BEFORE UPDATE ON collections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================

-- Full-text search function
CREATE OR REPLACE FUNCTION search_assets(
  search_query TEXT,
  category_filter UUID DEFAULT NULL,
  asset_type_filter VARCHAR DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  name VARCHAR,
  slug VARCHAR,
  description TEXT,
  rank real
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    a.id,
    a.name,
    a.slug,
    a.description,
    ts_rank(a.search_vector, plainto_tsquery('english', search_query)) as rank
  FROM assets a
  WHERE 
    a.search_vector @@ plainto_tsquery('english', search_query)
    AND a.status = 'published'
    AND (category_filter IS NULL OR a.category_id = category_filter)
    AND (asset_type_filter IS NULL OR a.asset_type = asset_type_filter)
  ORDER BY rank DESC;
END;
$$ LANGUAGE plpgsql;

-- Get asset with related materials
CREATE OR REPLACE FUNCTION get_asset_with_learning(
  asset_slug VARCHAR
)
RETURNS JSONB AS $$
DECLARE
  result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'asset', to_jsonb(a.*),
    'category', to_jsonb(c.*),
    'learning_materials', (
      SELECT jsonb_agg(to_jsonb(lm.*))
      FROM learning_materials lm
      WHERE lm.asset_id = a.id AND lm.status = 'published'
      ORDER BY lm.difficulty_level
    ),
    'related_assets', (
      SELECT jsonb_agg(jsonb_build_object(
        'asset', to_jsonb(ra.*),
        'relationship_type', ar.relationship_type
      ))
      FROM asset_relationships ar
      JOIN assets ra ON ra.id = ar.to_asset_id
      WHERE ar.from_asset_id = a.id AND ra.status = 'published'
      LIMIT 6
    )
  ) INTO result
  FROM assets a
  LEFT JOIN categories c ON c.id = a.category_id
  WHERE a.slug = asset_slug;
  
  RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Semantic search using embeddings (requires pgvector)
CREATE OR REPLACE FUNCTION search_assets_semantic(
  query_embedding vector(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  name VARCHAR,
  slug VARCHAR,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    a.id,
    a.name,
    a.slug,
    1 - (ae.embedding <=> query_embedding) as similarity
  FROM asset_embeddings ae
  JOIN assets a ON a.id = ae.asset_id
  WHERE 
    a.status = 'published'
    AND 1 - (ae.embedding <=> query_embedding) > match_threshold
  ORDER BY ae.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;
