/****************************************************************************
 The MIT License (MIT)

 Copyright (c) 2014 Apigee Corporation

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights
 to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 copies of the Software, and to permit persons to whom the Software is
 furnished to do so, subject to the following conditions:

 The above copyright notice and this permission notice shall be included in
 all copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 THE SOFTWARE.
 ****************************************************************************/
'use strict';

var _ = require('underscore');
var path = require('path');
var debug = require('debug')('swagger');

var swagger;
var resourcesMap; // name -> volos resource
var authorizationsMap; // operationId -> middleware chain

var SERVICES = ['x-a127-services', 'x-volos-resources'];
var VOLOS_AUTH = 'x-volos-authorizations';
var A127_AUTH = 'x-a127-authorizations';
var OAUTH_PROP = 'x-volos-oauth-service';

var yamljs = require('yamljs');
var oauthSwagger = require('../spec/oauth_operations.yaml');

var helpers = require('./helpers');

module.exports = middleware;

// config is a hash
// config.helpers is a directory path pointing to helper modules. defaults to 'api/helpers'.
function middleware(swaggerObject, config) {

  config = config || {};
  helpers.init(config);

  setSwagger(swaggerObject);

  authorizationsMap = {};

  var mwFunction = function(req, res, next) {
    if (debug.enabled) { debug('handle req: ' + req.path); }
    if (!(req.swagger && req.swagger.operation)) { return next(); }

    if (!swagger) {
      setSwagger(req.swagger.swaggerObject);
    }

    ifAuthenticated(req, res, next);
  };

  mwFunction.resources = resourcesMap; // backward compatible and exposes the resourceMap to clients
  mwFunction.controllers = path.resolve(__dirname, 'controllers'); // to map default oauth token routes
  mwFunction.swaggerSecurityHandlers = swaggerSecurityHandlers();

  return mwFunction;
}

function swaggerSecurityHandlers() {

  var handlers = {}; // name -> handler

  _.each(resourcesMap, function(resource, name) {
    if (resource.validGrantTypes) { // validGrantTypes only exists on oauth
      handlers[name] = new SwaggerSecurityHandler(resource);
    }
  });

  return handlers;
}

function SwaggerSecurityHandler(oauth) {

  return function(request, securityDefinition, scopes, cb) {
    if (securityDefinition.type !== 'oauth2') {
      debug('Invalidate type for security handler (%s). Must be "oauth2"', securityDefinition.type);
      return cb();
    }
    if (debug.enabled) { debug('authenticate scopes: %s', scopes); }
    oauth.verifyToken(
      request.headers.authorization,
      scopes,
      function(err, result) {
        if (err) {
          if (debug.enabled) {
            debug('Authentication error: ' + err);
          }
          cb(err);
        } else {
          request.token = result;
          cb();
        }
      }
    );
  }
}


function addResourcesToRequestMW() {
  var resources = {
    resources: resourcesMap
  };
  return function(req, res, next) {
    req.volos = resources;
    next();
  };
}

function setSwagger(swaggerObject) {
  if (swaggerObject) {
    swagger = swaggerObject;
    resourcesMap = createResources();
  }
}

// check Swagger OAuth2
function ifAuthenticated(req, res, next) {

  var operation = req.swagger.operation;
  var authChain = operation.volos ? operation.volos.authChain : undefined; // cache

  if (!authChain) {
    if (debug.enabled) { debug('creating auth chain for: ' + operation.operationId); }

    var authorizations = operation[A127_AUTH] ||
                         req.swagger.path[A127_AUTH] ||
                         operation[VOLOS_AUTH] ||
                         req.swagger.path[VOLOS_AUTH];

    var middlewares = [];
    if (authorizations) {
      _.each(authorizations, function(authorization, name) {
        var oauth = resourcesMap[name];
        if (debug.enabled) { debug('authenticate scope: ' + authorization.scope); }
        middlewares.push(oauth.connectMiddleware().authenticate(authorization.scope));
      });
    }

    middlewares.push(addResourcesToRequestMW());
    authChain = helpers.chain(middlewares);

    if (!operation.volos) { operation.volos = {}; }
    operation.volos.authChain = authChain;
  }

  authChain(req, res, next);
}

function createResources() {

  var services = {};

  SERVICES.forEach(function(serviceDefNameTuple) {
    _.each(swagger[serviceDefNameTuple], function(serviceDefinition, serviceName) {
      var module = require(serviceDefinition.provider);

      if (debug.enabled) {
        debug('creating service: ' + serviceName);
        debug('module: ' + serviceDefinition.provider);
        debug('options: ' + JSON.stringify(serviceDefinition.options));
      }

      if (serviceDefinition.options.passwordCheck) { // only exists on oauth
        serviceDefinition.options.passwordCheck =
          helpers.getHelperFunction(serviceName + ' passwordCheck', serviceDefinition.options.passwordCheck);
      }

      var service = module.create.apply(this, [serviceDefinition.options]);

      if (serviceDefinition.options.tokenPaths) { // only exists on oauth
        importOAuth(serviceName, serviceDefinition.options.tokenPaths);
      }

      services[serviceName] = service;
    });
  });

  return services;
}

function importOAuth(resourceName, paths) {

  if (paths.length === 0) { return; }

  var allPaths = swagger.paths || (swagger.paths = {});
  var allDefinitions = swagger.definitions || (swagger.definitions = {});

  // err if would overwrite any paths
  var existingPaths = _.filter(paths, function(path) { return _.contains(allPaths, path); });
  if (existingPaths.length > 0) {
    throw new Error('Paths ' + existingPaths + ' already exist. Cannot insert OAuth.');
  }

  // err if would overwrite any definitions
  var existingDefinitions = _.filter(allDefinitions, function(key) {
    return _.contains(Object.keys(oauthSwagger.definitions), key);
  });
  if (existingDefinitions.length > 0) {
    throw new Error('Definitions ' + existingDefinitions + ' already exist. Cannot insert OAuth.');
  }

  // add the token paths
  _.each(paths, function(path, name) {
    var keyPath = '/' + name;
    allPaths[path] = oauthSwagger.paths[keyPath];
    if (!allPaths[path]) {
      var keys = Object.keys(oauthSwagger.paths).map(function(key) { return key.substring(1); });
      throw new Error('Invalid tokenPath key: ' + name + '. Must be one of: ' + keys);
    }
    allPaths[path][OAUTH_PROP] = resourceName;
  });

  // add the definitions
  _.each(oauthSwagger.definitions, function(value, key) {
    allDefinitions[key] = value;
  });
}
