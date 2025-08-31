// Global error handler middleware
const errorHandler = (err, req, res, next) => {
  console.error('❌ Error:', err.stack);

  // Default error
  let error = { ...err };
  error.message = err.message;

  // Log error for debugging
  console.error('Error details:', {
    message: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    body: req.body,
    params: req.params,
    query: req.query
  });

  // SQLite errors
  if (err.code && err.code.startsWith('SQLITE_')) {
    error.message = 'Database error occurred';
    error.statusCode = 500;
  }

  // Validation errors
  if (err.name === 'ValidationError') {
    error.message = 'Validation error';
    error.statusCode = 400;
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    error.message = 'Invalid token';
    error.statusCode = 401;
  }

  // Default to 500 server error
  res.status(error.statusCode || 500).json({
    success: false,
    error: error.message || 'Server Error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
};

module.exports = errorHandler;
