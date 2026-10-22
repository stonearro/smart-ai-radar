'use strict';

const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');

/**
 * A persona describes *how* to read the news: which categories and tags matter,
 * how much to trust a source, and which output formats to prefer.
 */
class Persona {
  constructor(data = {}) {
    this.id = data.id || `persona_${Date.now()}`;
    this.name = data.name || '未命名 Persona';
    this.description = data.description || '';
    this.category = data.category || 'general';
    this.language = data.language || 'zh-CN';
    this.expertise = Array.isArray(data.expertise) ? data.expertise : [];
    this.analysisFocus = Array.isArray(data.analysisFocus) ? data.analysisFocus : [];
    this.filter = {
      categories: Array.isArray(data.filter?.categories) ? data.filter.categories : [],
      tags: Array.isArray(data.filter?.tags) ? data.filter.tags : [],
      keywords: Array.isArray(data.filter?.keywords) ? data.filter.keywords : []
    };
    this.credibilityWeight =
      typeof data.credibilityWeight === 'number' ? data.credibilityWeight : 0.5;
    this.outputFormats =
      Array.isArray(data.outputFormats) && data.outputFormats.length > 0
        ? data.outputFormats
        : ['html', 'markdown', 'json'];
    this.isActive = data.isActive !== false;
    this.createdAt = data.createdAt || new Date().toISOString();
    this.updatedAt = data.updatedAt || new Date().toISOString();
    this.metadata = data.metadata || {};
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      category: this.category,
      language: this.language,
      expertise: this.expertise,
      analysisFocus: this.analysisFocus,
      filter: this.filter,
      credibilityWeight: this.credibilityWeight,
      outputFormats: this.outputFormats,
      isActive: this.isActive,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      metadata: this.metadata
    };
  }
}

class PersonaManager {
  constructor(config = {}) {
    this.personaDir = path.resolve(config.rootDir || process.cwd(), config.personaDir || 'personas');
    this.personas = [];
    this.byId = new Map();
  }

  async initialize() {
    await fs.mkdir(this.personaDir, { recursive: true });
    await this.load();

    logger.info('PersonaManager ready', {
      personas: this.personas.length,
      dir: path.basename(this.personaDir)
    });
    return this;
  }

  async load() {
    this.personas = [];
    const files = (await fs.readdir(this.personaDir)).filter((file) => file.endsWith('.json'));

    for (const file of files) {
      try {
        const raw = await fs.readFile(path.join(this.personaDir, file), 'utf8');
        const data = JSON.parse(raw);

        if (!data || typeof data.name !== 'string' || data.name.trim() === '') {
          logger.warn('Skipping persona without a name', { file });
          continue;
        }

        const persona = new Persona({ id: path.basename(file, '.json'), ...data });
        this.personas.push(persona);
      } catch (error) {
        logger.warn('Skipping unreadable persona', { file, error: error.message });
      }
    }

    this.reindex();
    return this.personas;
  }

  reindex() {
    this.byId = new Map(this.personas.map((persona) => [persona.id, persona]));
  }

  listPersonas() {
    return this.personas.filter((persona) => persona.isActive);
  }

  getPersona(id) {
    return this.byId.get(id) || null;
  }

  getPersonasByCategory(category) {
    return this.listPersonas().filter((persona) => persona.category === category);
  }

  async addPersona(data) {
    const persona = new Persona(data);
    if (this.byId.has(persona.id)) {
      throw new Error(`Persona "${persona.id}" already exists`);
    }

    await this.persist(persona);
    this.personas.push(persona);
    this.reindex();

    logger.info('Persona created', { id: persona.id });
    return persona;
  }

  async updatePersona(id, updates = {}) {
    const existing = this.getPersona(id);
    if (!existing) {
      throw new Error(`Persona "${id}" not found`);
    }

    const merged = new Persona({
      ...existing.toJSON(),
      ...updates,
      id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString()
    });

    await this.persist(merged);
    this.personas = this.personas.map((persona) => (persona.id === id ? merged : persona));
    this.reindex();

    logger.info('Persona updated', { id });
    return merged;
  }

  async deletePersona(id) {
    const existing = this.getPersona(id);
    if (!existing) {
      throw new Error(`Persona "${id}" not found`);
    }

    await fs.unlink(this.personaFile(id)).catch(() => {});
    this.personas = this.personas.filter((persona) => persona.id !== id);
    this.reindex();

    logger.info('Persona deleted', { id });
    return existing;
  }

  /**
   * Rank personas against a user profile (categories / language / expertise).
   */
  recommendPersonas(userProfile = {}, limit = 3) {
    const scored = this.listPersonas().map((persona) => {
      let score = 0;

      const wantedCategories = userProfile.categories || [];
      if (persona.filter.categories.some((category) => wantedCategories.includes(category))) {
        score += 0.35;
      }

      if (persona.category && wantedCategories.includes(persona.category)) {
        score += 0.2;
      }

      if (userProfile.language && persona.language === userProfile.language) {
        score += 0.15;
      }

      const wantedExpertise = (userProfile.expertise || []).map((item) => String(item).toLowerCase());
      if (persona.expertise.length > 0 && wantedExpertise.length > 0) {
        const overlap = persona.expertise.filter((item) =>
          wantedExpertise.includes(String(item).toLowerCase())
        ).length;
        score += (overlap / persona.expertise.length) * 0.2;
      }

      score += persona.credibilityWeight * 0.1;

      return { persona, score };
    });

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => ({ ...entry.persona.toJSON(), matchScore: Number(entry.score.toFixed(3)) }));
  }

  async persist(persona) {
    await fs.mkdir(this.personaDir, { recursive: true });
    await fs.writeFile(this.personaFile(persona.id), `${JSON.stringify(persona.toJSON(), null, 2)}\n`, 'utf8');
  }

  personaFile(id) {
    return path.join(this.personaDir, `${id}.json`);
  }
}

module.exports = { Persona, PersonaManager };
